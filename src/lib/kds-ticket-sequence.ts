/**
 * PRIMERJAVA §38 (v1.264.0) — ROČNO ZAPOREDJE LISTKOV NA KDS (Square
 * Vol 16 »Draggable ticket reordering on KDS«): strežniški dostop do
 * stolpca Order."ticketSequence" — IZKLJUČNO raw SQL s probo
 * (vzorec receipt-display-policy §37 / exception-policy; main schema
 * stolpca NIMA do produkcijskega DDL klika — P2022 zastrupitev
 * tipiziranih poizvedb; dev SQLite mirror ga ima prek db:push).
 *
 *  - readTicketSequences(orderIds) → mapa samo ZA VPISANE sekvence
 *    (pre-DDL → prazna mapa — vrsta enaka default, GRACEFUL);
 *  - writeTicketSequences(entries) → interaktivna transakcija
 *    (pre-DDL → napaka, klicatelj odgovori 503 s potjo konzole —
 *    nikoli tihe odpovedi, seat-db/haccp disciplina);
 *  - SSE podpis se namerno NE dvigne (§38 B7): raw UPDATE ne piše
 *    updatedAt — reorder ni vsebinska sprememba listka, kdsFlash
 *    utrip »NOV« bi bil lažni alarm.
 */
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { isMissingSchemaError } from './prisma-missing'

const PROBE_TTL_MS = 60_000

let cached: { value: boolean; at: number } | null = null

/** Ponastavi probe (po DDL / v testih). Z vrednostjo jo vsili. */
export function resetKdsTicketSequenceProbe(value?: boolean): void {
  cached = value === undefined ? null : { value, at: Date.now() }
}

/** Ali stolpec Order."ticketSequence" obstaja na trenutni bazi? (memoizirano, 60 s) */
export async function kdsTicketSequenceAvailable(): Promise<boolean> {
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value
  try {
    await db.$queryRawUnsafe(`SELECT "ticketSequence" FROM "Order" LIMIT 1`)
    cached = { value: true, at: Date.now() }
  } catch (e) {
    cached = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return cached.value
}

/** Vrstica za pisanje (id + ciljno mesto; null = počisti mesto). */
export interface TicketSequenceWrite {
  orderId: string
  sequence: number | null
}

/**
 * Prebere ROČNA mesta listkov (samo vpisane — izpuščene ne zanimajo
 * klienta, NULL pomeni »ni mesta«). Pre-DDL → prazna mapa (graceful).
 * Infra napake se propagirajo (resnica, ne maskirana praznina).
 */
export async function readTicketSequences(orderIds: readonly string[]): Promise<Record<string, number>> {
  if (orderIds.length === 0) return {}
  if (!(await kdsTicketSequenceAvailable())) return {}
  const uniq = [...new Set(orderIds)]
  const rows = await db.$queryRaw<{ id: string; ticketSequence: number | null }[]>`
    SELECT "id", "ticketSequence" FROM "Order" WHERE "id" IN (${Prisma.join(uniq)})
  `
  const out: Record<string, number> = {}
  for (const r of rows) {
    // defenzivno (§36): samo končne vrednosti so ročna mesta
    if (typeof r.ticketSequence === 'number' && Number.isFinite(r.ticketSequence)) {
      out[r.id] = r.ticketSequence
    }
  }
  return out
}

/**
 * Zapiše ročna mesta v ENI interaktivni transakciji (celotna
 * zamenjava — klicatelj pošlje VSE liste, ki jih želi vpisati, in
 * eksplicitno NULL za brisanje). Pre-DDL → vrne sporočilo (503).
 * Vrnjena vrednost: napaka (string) | null.
 */
export async function writeTicketSequences(entries: readonly TicketSequenceWrite[]): Promise<string | null> {
  if (entries.length === 0) return null
  if (!(await kdsTicketSequenceAvailable())) {
    return 'Ročno zaporedje listkov čaka DDL korak (Enterprise → Shema migracije → kds-ticket-sequence).'
  }
  await db.$transaction(async (tx) => {
    for (const e of entries) {
      // vezani parameter (Prisma.join zgoraj uporablja template — tu
      // eksplicitno prepared obliko; vrednost je številka ali NULL)
      if (e.sequence === null) {
        await tx.$executeRaw`UPDATE "Order" SET "ticketSequence" = NULL WHERE "id" = ${e.orderId}`
      } else if (Number.isInteger(e.sequence) && e.sequence >= 0) {
        await tx.$executeRaw`UPDATE "Order" SET "ticketSequence" = ${e.sequence} WHERE "id" = ${e.orderId}`
      } else {
        throw new Error('Sekvenca mora biti nenegativno celo število ali null.')
      }
    }
  })
  return null
}
