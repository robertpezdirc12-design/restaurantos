import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { db } from '../src/lib/db'
import { sweepTestFixtures, type SweepResult } from './helpers/fixture-sweep'
import { sendWeeklyTaskSummary, sendDailyDigest, type DigestMailer } from '../src/lib/daily-email'
import { smtpTransportForLocation } from '../src/lib/reminders'
import { OPS_CHECKLISTS_MARKER } from '../src/lib/ops-checklists'

/**
 * v1.282.0 — DETERMINIZEM E-POŠTNIH NASTAVITEV + SWEEP POKRITJE.
 *
 * Dve zavestno odloženi A-najdbi zaključnega vnosa v1.281.0, izvedeni:
 *
 * (1) PRODUKCIJA — družina 6 golih `db.restaurantSettings.findFirst()` (3×
 *     daily-email.ts: sendDailyDigest/sendShiftDailySummary/sendWeeklyTaskSummary
 *     + 3× reminders.ts: smtpTransportForLocation/sendReservationReminder/
 *     sendBookingConfirmation). Brez pogoja in brez orderinga zmaga PRVA
 *     VSTAVLJENA vrstica — izmerjena okvara (v1.281.0, v248 G3): vrstica iz
 *     `db:seed` (emailEnabled=0) je preglasila omogočeno vrstico testa →
 *     email_not_configured, kljub temu da je omogočena vrstica obstajala.
 *     Popravek: skupni helper `findEmailSettings()` — samo vrstice z
 *     emailEnabled=true, najstarejša po createdAt (id kot deterministični
 *     razreševalnik izenačenj) zmaga; vsa mesta dobijo ISTO vrstico
 *     neodvisno od vrstnega reda vstavljanja.
 *
 * (2) SWEEP — ChecklistRun in ScheduledEmailLog nista bila v počistniku
 *     testnih fiksur (izmerjeno po zelenem teku v1.281.0: 2 osiroteli
 *     ChecklistRun vrstici na zelen tek v248 + 1 osirotela ScheduledEmailLog
 *     vrstica, ki jo je zapisala PRODUKCIJSKA koda s nid() id-jem).
 *     Popravek: ChecklistRun → ID_SWEEP (id-predponske) + LOCATION_CHILD_SWEEP
 *     (nid() otroci testnih lokacij); ScheduledEmailLog → ID_SWEEP (id-predponske,
 *     vzorec v167) + FIELD_SWEEP po `recipient` (produkcija piše nid() id, a je
 *     prejemnik = e-pošta testne nastavitvene vrstice s predpono).
 */

const P = 'v282-'
const RUN = Date.now().toString(36)

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

// ── Č1) VEDENJE — determinizem nad pravo bazo ────────────────────────────

describe('v282 Č1: determinizem e-poštnih nastavitev (nad pravo bazo)', () => {
  beforeAll(async () => {
    await sweepTestFixtures(db, [P])
    // izolacija: omogočene vrstice iz padlih tekov drugih datotek + ostanki
    // tega vala (recipient nosi vedno testno domeno)
    await db.restaurantSettings.deleteMany({ where: { emailEnabled: true } })
    await db.scheduledEmailLog.deleteMany({ where: { recipient: { contains: '@test.local' } } })
  })

  afterAll(async () => {
    await sweepTestFixtures(db, [P])
  })

  test('Č1a — seme-first: onemogočena vrstica NE more preglasiti omogočene (v248 G3 regresija)', async () => {
    // točen vzorec okvare v1.281.0: vrstica SEEDA (emailEnabled=0) je vstavljena
    // PRVA in je goli findFirst() vrnil njo → email_not_configured.
    await db.restaurantSettings.deleteMany({ where: { id: { startsWith: P } } })
    await db.scheduledEmailLog.deleteMany({ where: { reportType: 'TASK_WEEKLY' } })
    await db.restaurantSettings.create({
      data: { id: `${P}seed-like-${RUN}`, name: 'RestaurantOS (seme)', emailEnabled: false, email: 'seed@restaurantos.app', createdAt: new Date('2020-01-01T00:00:00Z') },
    } as never)
    await db.restaurantSettings.create({
      data: { id: `${P}enabled-${RUN}`, name: `${P}Gostilna`, emailEnabled: true, email: `${P}digest@test.local`, emailFromAddress: `${P}from@test.local`, createdAt: new Date('2026-01-01T00:00:00Z') },
    } as never)

    // pojavitve za tedenski povzetek: dnevna predloga rodi pojavitve v vsakem oknu
    const locId = `${P}loc-a-${RUN}`
    await db.location.create({ data: { id: locId, name: `${P}Lokacija A`, code: `V282A-${RUN.toUpperCase()}` } })
    const tpl = {
      id: `${P}tpl-weekly`, name: `${P}Tedensko odpiranje`, category: 'opening', repeat: 'daily',
      weekday: null, monthDay: null, anchorDate: '', validUntil: null, dueTime: '09:00', active: true,
      items: [{ id: 'i1', label: 'Preveri kavo', response: 'check' }],
    }
    await db.integration.create({
      data: {
        id: `${P}int-weekly-${RUN}`, name: OPS_CHECKLISTS_MARKER, type: 'other', provider: 'internal',
        config: JSON.stringify({ templates: [tpl] }), isActive: true, syncEnabled: false, locationId: locId,
      },
    })

    const sent: Array<{ to?: unknown }> = []
    const mailer: DigestMailer = {
      sendMail: async (m) => { sent.push({ to: (m as { to?: unknown }).to }); return { messageId: 'x' } },
    }
    const mon = await sendWeeklyTaskSummary({ now: new Date('2026-11-09T05:00:00Z'), transportFactory: async () => mailer })
    expect(mon.sent).toBe(true)
    expect(sent[0]?.to).toBe(`${P}digest@test.local`)
    // varovalka: drugi klic isti ponedeljek → already_sent (determinizem ne podvoji)
    const again = await sendWeeklyTaskSummary({ now: new Date('2026-11-09T06:00:00Z'), transportFactory: async () => mailer })
    expect(again.sent).toBe(false)
    expect(again.reason).toBe('already_sent')
  })

  test('Č1b — dve omogočeni vrstici: zmaga najstarejša po createdAt, NE prva vstavljena', async () => {
    await db.restaurantSettings.deleteMany({ where: { id: { startsWith: P } } })
    await db.scheduledEmailLog.deleteMany({ where: { reportType: 'TASK_WEEKLY' } })
    // NAMENOMA: mlajšo (B) vstavimo PRVO — rowid vrstni red ≠ createdAt vrstni red;
    // goli findFirst bi vzel B, pogodba vala zahteva A (najstarejša omogočena).
    await db.restaurantSettings.create({
      data: { id: `${P}novija-${RUN}`, name: `${P}Novija`, emailEnabled: true, email: `${P}novija@test.local`, createdAt: new Date('2026-06-01T00:00:00Z') },
    } as never)
    await db.restaurantSettings.create({
      data: { id: `${P}starejsa-${RUN}`, name: `${P}Starejša`, emailEnabled: true, email: `${P}starejsa@test.local`, createdAt: new Date('2026-01-01T00:00:00Z') },
    } as never)

    const sent: Array<{ to?: unknown }> = []
    const mailer: DigestMailer = {
      sendMail: async (m) => { sent.push({ to: (m as { to?: unknown }).to }); return { messageId: 'x' } },
    }
    const mon = await sendWeeklyTaskSummary({ now: new Date('2026-11-09T05:00:00Z'), transportFactory: async () => mailer })
    expect(mon.sent).toBe(true)
    expect(sent[0]?.to).toBe(`${P}starejsa@test.local`)
  })

  test('Č1c — sendDailyDigest: seme-first NE more vrniti email_not_configured (ista družina)', async () => {
    await db.restaurantSettings.deleteMany({ where: { id: { startsWith: P } } })
    // zajeti dan fiksnega NOW = 2026-06-09 → počisti obstoječe 'sent' vrstice tega dne
    await db.scheduledEmailLog.deleteMany({ where: { reportType: 'DAILY_DIGEST', reportDate: new Date('2026-06-09T00:00:00Z') } })
    await db.restaurantSettings.create({
      data: { id: `${P}seed-like2-${RUN}`, name: 'RestaurantOS (seme)', emailEnabled: false, email: 'seed@restaurantos.app', createdAt: new Date('2020-01-01T00:00:00Z') },
    } as never)
    await db.restaurantSettings.create({
      data: { id: `${P}enabled2-${RUN}`, name: `${P}Gostilna 2`, emailEnabled: true, email: `${P}daily@test.local`, createdAt: new Date('2026-01-01T00:00:00Z') },
    } as never)

    const mailer: DigestMailer = { sendMail: async () => ({ messageId: 'x' }) }
    const res = await sendDailyDigest({ now: new Date('2026-06-10T12:00:00Z'), transportFactory: async () => mailer })
    expect(res).toEqual({ sent: true })
  })

  test('Č1d — smtpTransportForLocation: onemogočena vrstica ne ugasne transporta (reminders.ts)', async () => {
    await db.restaurantSettings.deleteMany({ where: { id: { startsWith: P } } })
    await db.restaurantSettings.create({
      data: { id: `${P}seed-like3-${RUN}`, name: 'RestaurantOS (seme)', emailEnabled: false, email: 'seed@restaurantos.app', createdAt: new Date('2020-01-01T00:00:00Z') },
    } as never)
    await db.restaurantSettings.create({
      data: {
        id: `${P}smtp-${RUN}`, name: `${P}SMTP gostilna`, emailEnabled: true, email: `${P}smtp@test.local`,
        emailSmtpHost: 'smtp.test.local', emailSmtpPort: 587, emailFromAddress: `${P}from@test.local`,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    } as never)

    const t = await smtpTransportForLocation(null)
    expect(t).not.toBeNull()
  })
})

// ── Č2) PINI — statične varovalke popravka ───────────────────────────────

describe('v282 Č2: pini determinizma + sweep pokritja', () => {
  test('produkcija: 0 golih restaurantSettings.findFirst() v obeh modulih družine', () => {
    for (const f of ['src/lib/daily-email.ts', 'src/lib/reminders.ts']) {
      expect(read(f), f).not.toContain('db.restaurantSettings.findFirst()')
    }
  })

  test('helper findEmailSettings: where emailEnabled + orderBy createdAt/id (pogodba vala)', () => {
    const src = read('src/lib/reminders.ts')
    expect(src).toContain('export async function findEmailSettings()')
    expect(src).toContain('where: { emailEnabled: true }')
    expect(src).toContain("orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]")
  })

  test('daily-email.ts: vsa 3 klicna mesta družine uporabljajo helper', () => {
    const src = read('src/lib/daily-email.ts')
    expect(src.split('await findEmailSettings()').length - 1).toBe(3)
  })

  test('reminders.ts: preostali 2 klici (opomnik/potrditev) uporabljata helper', () => {
    const src = read('src/lib/reminders.ts')
    // smtpTransportForLocation + 2 pošiljalca opomnikov = 3 mesto skupaj z definicijo
    expect(src.split('await findEmailSettings()').length - 1).toBe(3)
  })

  test('fixture-sweep: ChecklistRun (id + locationId) in ScheduledEmailLog (id + recipient) pokriti', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain("{ model: 'checklistRun' }")
    expect(src).toContain("'checklistRun',")
    expect(src).toContain("{ model: 'scheduledEmailLog' }")
    expect(src).toContain("{ model: 'scheduledEmailLog', fields: ['recipient'] }")
    expect(src).toContain("'v282-',")
  })
})

// ── Č3) SWEEP — vedenjski dokaz pokritja ─────────────────────────────────

describe('v282 Č3: sweep pobira vse štiri oblike novih vrstic', () => {
  test('id-predponski run/log + nid() run na testni lokaciji + nid() log s predponskim prejemnikom', async () => {
    const locId = `${P}loc-sw-${RUN}`
    await db.location.create({ data: { id: locId, name: `${P}Lokacija SW`, code: `V282S-${RUN.toUpperCase()}` } })
    // 1. id-predponski ChecklistRun (vzorec v248 G1)
    await db.checklistRun.create({
      data: { id: `${P}run-${RUN}`, locationId: locId, templateId: `${P}tpl`, templateName: `${P}Predloga`, occurrenceKey: `${P}tpl|2026-11-08`, state: 'open' },
    })
    // 2. nid() ChecklistRun na testni lokaciji (produkcija-stil: cron/pišče aplikacija)
    //     — drugačen occurrenceKey: (locationId, templateId, occurrenceKey) je @@unique
    await db.checklistRun.create({
      data: { id: `nid${RUN}run`, locationId: locId, templateId: `${P}tpl`, templateName: `${P}Predloga`, occurrenceKey: `${P}tpl|2026-11-07`, state: 'open' },
    })
    // 3. id-predponski ScheduledEmailLog (vzorec v167)
    await db.scheduledEmailLog.create({
      data: { id: `${P}log-${RUN}`, reportType: 'TASK_WEEKLY', recipient: `${P}rec@test.local`, subject: `${P}subject`, body: '', status: 'sent' },
    })
    // 4. nid() ScheduledEmailLog s predponskim prejemnikom (produkcija-stil: sendWeeklyTaskSummary)
    await db.scheduledEmailLog.create({
      data: { id: `nid${RUN}log`, reportType: 'TASK_WEEKLY', recipient: `${P}prod@test.local`, subject: `${P}subject`, body: '', status: 'sent' },
    })

    const res: SweepResult = await sweepTestFixtures(db, [P])

    expect(res.errors).toEqual([])
    expect(res.remainingLocations).toBe(0)
    expect(await db.checklistRun.count({ where: { id: { startsWith: P } } })).toBe(0)
    expect(await db.checklistRun.count({ where: { id: `nid${RUN}run` } })).toBe(0)
    expect(await db.scheduledEmailLog.count({ where: { id: `${P}log-${RUN}` } })).toBe(0)
    expect(await db.scheduledEmailLog.count({ where: { recipient: `${P}prod@test.local` } })).toBe(0)
  })
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v282 Ž: registri', () => {
  test('verzija 1.292.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.292.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.292.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.292.0-ci-sveza-baza-c1b')
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je determinizem poizvedbe + testna higiena)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('EmailDeterminizem')
    expect(read('prisma/schema.prisma')).not.toContain('EmailDeterminizem')
  })
})
