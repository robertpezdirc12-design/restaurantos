/**
 * v1.167.0 — dnevni digest se sme poslati ENKRAT na zajeti dan.
 *
 * Najdba je zapisana v izdaji v1.161.0: cron ima marker `already_ran_today`, a
 * marker se ob napaki NE zapiše (pravilno — lažni uspeh v markerju je slabši od
 * ponovitve). Posledica: istodnevna ročna ponovitev zažene vse korake znova,
 * med njimi digest. Ostali koraki so idempotentni (recurring pravila, AP push,
 * lot/HACCP markerji); digest je e-pošta, je ne moremo umakniti.
 *
 * To je prvi test, ki sploh zaide v VEJO POŠILJANJA. Doslej je bil
 * `sendDailyDigest` krito samo prek gradnikov besedila, ker transport potrebuje
 * SMTP nastavitve v bazi — zato je napaka lahko živela toliko časa. Parameter
 * `transportFactory` je testni šiv: v testu šteje klice, v produkciji ostane
 * privzeti `smtpTransportForLocation`.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { db } from '../src/lib/db'
import { sendDailyDigest } from '../src/lib/daily-email'
import { startOfDay } from '../src/lib/cron-daily'

const P = 'v167-'
const RECIPIENT = 'v167-digest@example.local'
const FAILED_RECIPIENT = 'v167-failed@example.local'

/** Fiksni trenutek: oba klica morata izračunati isti zajeti dan. */
const NOW = new Date('2026-06-10T12:00:00Z')
const to = startOfDay(NOW)
const FROM = new Date(to.getTime())
FROM.setDate(FROM.getDate() - 1)

let sendCalls = 0
const mailer = { sendMail: async (): Promise<{ messageId: string }> => { sendCalls++; return { messageId: `${P}msg` } } }
const transportFactory = async (): Promise<typeof mailer> => mailer

let settingsId: string | null = null
let savedSettings: { email: string; emailEnabled: boolean } | null = null

async function clearDigestRows(): Promise<void> {
  await db.scheduledEmailLog.deleteMany({ where: { recipient: { in: [RECIPIENT, FAILED_RECIPIENT] } } })
}

async function setEmailEnabled(on: boolean): Promise<void> {
  if (!settingsId) throw new Error(`${P} nastavitve ne obstajajo — predpogoj testa ni izpolnjen`)
  await db.restaurantSettings.update({ where: { id: settingsId }, data: { emailEnabled: on } })
}

beforeAll(async () => {
  const existing = await db.restaurantSettings.findFirst()
  if (existing) {
    settingsId = existing.id
    savedSettings = { email: existing.email, emailEnabled: existing.emailEnabled }
    await db.restaurantSettings.update({ where: { id: existing.id }, data: { email: RECIPIENT, emailEnabled: true } })
  } else {
    settingsId = `${P}settings`
    await db.restaurantSettings.create({ data: { id: settingsId, email: RECIPIENT, emailEnabled: true } })
  }
  await clearDigestRows()
})

afterAll(async () => {
  await clearDigestRows()
  if (settingsId && savedSettings) {
    await db.restaurantSettings.update({ where: { id: settingsId }, data: { email: savedSettings.email, emailEnabled: savedSettings.emailEnabled } })
  } else if (settingsId) {
    await db.restaurantSettings.delete({ where: { id: settingsId } })
  }
})

describe('v1.167.0 — dedupe dnevnega digesta po ScheduledEmailLog', () => {
  beforeEach(async () => {
    sendCalls = 0
    await clearDigestRows()
    await setEmailEnabled(true)
  })

  test('prvi klic pošlje e-pošto in zapiše vrstico sent za zajeti dan', async () => {
    const res = await sendDailyDigest({ now: NOW, transportFactory })
    expect(res).toEqual({ sent: true })
    expect(sendCalls).toBe(1)
    const rows = await db.scheduledEmailLog.findMany({ where: { reportType: 'DAILY_DIGEST', recipient: RECIPIENT } })
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('sent')
    expect(rows[0].reportDate?.getTime()).toBe(FROM.getTime())
  })

  test('drugi klic istega dne ne pošlje znova in ne zapiše druge vrstice', async () => {
    await sendDailyDigest({ now: NOW, transportFactory })
    const res = await sendDailyDigest({ now: NOW, transportFactory })
    expect(res.sent).toBe(false)
    expect(res.reason).toBe('already_sent')
    expect(sendCalls).toBe(1)
    expect(await db.scheduledEmailLog.count({ where: { reportType: 'DAILY_DIGEST', recipient: RECIPIENT } })).toBe(1)
  })

  test('neuspešna vrstica istega dne ne blokira ponovitve — sporočilo ni bilo dostavljeno', async () => {
    await db.scheduledEmailLog.create({
      data: {
        id: `${P}failed`, reportType: 'DAILY_DIGEST', recipient: FAILED_RECIPIENT, subject: `${P}subject`,
        body: '', status: 'failed', errorMessage: `${P} smtp down`, reportDate: FROM,
      },
    })
    const res = await sendDailyDigest({ now: NOW, transportFactory })
    expect(res).toEqual({ sent: true })
    expect(sendCalls).toBe(1)
  })

  test('poslan digest prejšnjega dne ne blokira današnjega', async () => {
    const prev = new Date(FROM.getTime())
    prev.setDate(prev.getDate() - 1)
    await db.scheduledEmailLog.create({
      data: {
        id: `${P}prev`, reportType: 'DAILY_DIGEST', recipient: RECIPIENT, subject: `${P}subject`,
        body: '', status: 'sent', sentAt: new Date(), reportDate: prev,
      },
    })
    const res = await sendDailyDigest({ now: NOW, transportFactory })
    expect(res).toEqual({ sent: true })
    expect(sendCalls).toBe(1)
  })

  test('dedupe se preveri prvi: izklopljen e-poštni profil ne prekrije že poslanega dna', async () => {
    await sendDailyDigest({ now: NOW, transportFactory })
    await setEmailEnabled(false)
    const res = await sendDailyDigest({ now: NOW, transportFactory })
    expect(res.reason).toBe('already_sent')
    expect(sendCalls).toBe(1)
  })
})
