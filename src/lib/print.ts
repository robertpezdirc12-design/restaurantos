/**
 * Issue #10 P2-3 — server-side evidence tiskalnih poskusov (print ACK).
 *
 * Kontekst (issue #10, točka 3): print poteka client → print-agent mini-service
 * (port 3031) → ESC/POS TCP 9100; agent vrne ok/error SINHRONO nazaj v brskalnik,
 * ampak ta rezultat se nikjer ne evidentira (brez sledi, brez audit, brez pregleda
 * napak). Ta modul doda evidence: vsak poskus tiska = ena vrstica PrintJob
 * (status printed | failed | simulated), napake → AuditLog PRINT_FAILED.
 *
 * Pravila:
 *  - ACK je fire-and-forget z client strani — NIKOLI ne sme vplivati na print tok (§18).
 *  - Občutljivih podatkov NE logiramo (samo kind/refId/target/error človeku berljivo).
 *  - Valide pne čista funkcija (parsePrintAck) — testabilna brez DB (bun test).
 */
import { r2 } from '@/lib/map'

export const PRINT_KINDS = ['receipt', 'kitchen', 'bar', 'report', 'other', 'label'] as const
export const PRINT_TARGETS = ['browser', 'agent', 'simulator'] as const
export const PRINT_STATUSES = ['printed', 'failed', 'simulated'] as const

export type PrintKind = (typeof PRINT_KINDS)[number]
export type PrintTarget = (typeof PRINT_TARGETS)[number]
export type PrintStatus = (typeof PRINT_STATUSES)[number]

export interface PrintAckInput {
  kind: PrintKind
  refId: string
  target: PrintTarget
  status: PrintStatus
  error: string
  attempts: number
  device: string
}

type Row = Record<string, unknown>

function s(v: unknown, max: number, fb = ''): string {
  const out = (typeof v === 'string' ? v.trim() : '')
  return (out || fb).slice(0, max)
}

/** Čista validacija ACK telesa — vrne podatke ALI napako (brez DB, brez stranskih učinkov). */
export function parsePrintAck(body: unknown): { ok: true; data: PrintAckInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Manjkajoče telo zahteve.' }
  }
  const b = body as Row

  const target = s(b.target, 20) as PrintTarget
  if (!(PRINT_TARGETS as readonly string[]).includes(target)) {
    return { ok: false, error: `Neznan cilj tiska (dovoljeno: ${PRINT_TARGETS.join(', ')}).` }
  }

  const status = s(b.status, 20) as PrintStatus
  if (!(PRINT_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `Neznan status tiska (dovoljeno: ${PRINT_STATUSES.join(', ')}).` }
  }

  const kindRaw = s(b.kind, 20, 'other').toLowerCase() as PrintKind
  const kind = (PRINT_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : 'other'

  const attemptsRaw = Number(b.attempts)
  const attempts = Number.isFinite(attemptsRaw) && attemptsRaw >= 1
    ? Math.min(50, Math.round(attemptsRaw))
    : 1

  return {
    ok: true,
    data: {
      kind,
      refId: s(b.refId, 64),
      target,
      status,
      error: status === 'failed' ? s(b.error, 500) : '',
      attempts,
      device: s(b.device, 120),
    },
  }
}

/** Iz naslova dokumenta sklepa kind, če klicalec ne poda konteksta ( dodaten signal, ni kritično). */
export function inferPrintKind(title: string): PrintKind {
  const t = (title || '').toUpperCase()
  if (t.includes('KUHINJ')) return 'kitchen'
  if (t.includes('BAR')) return 'bar'
  if (t.includes('RAČUN') || t.includes('RACUN') || t.includes('RECEIPT') || t.includes('DOKLAD')) return 'receipt'
  if (t.includes('POROČILO') || t.includes('POROCILO') || t.includes('Z-') || t.includes('REPORT')) return 'report'
  if (t.includes('ETIKET')) return 'label'
  return 'other'
}

/** Skrajša error za shrambo (prijazno do audit vrstice). */
export function cleanPrintError(err: unknown): string {
  const s = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err ?? '')
  return s.slice(0, 500)
}

/** Zaokroži znesek pri morebitnih (npr. prihodnjih) izpisih z ceno — konsistentno z ostalo kodo. */
export function printAmount(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? r2(x) : 0
}
