/**
 * Issue #33/#35/#36 (v1.94.0) — skupni strežniški helperji za MFA step-up,
 * atomarno porabo recovery kod in atomarno zahtevo TOTP koraka.
 *
 * Načela (enoten, preverljiv model — issue #31):
 *  - step-up = SVEŽ PIN (ista scrypt/pinLookup disciplina kot prijava,
 *    timing-safe primerjava). klientova trditev (reauthenticated=true ipd.)
 *    se NE sprejema — dokaz mora priti skozi strežniško preverbo;
 *  - vse spremembe MFA stanja so ATOMARNE (CAS/updateMany) — točno ena
 *    zmagovalka ob sočasnosti, poraženka fail-closed;
 *  - vsak zapis mfaRecoveryCodes poviša mfaRecoveryVersion (CAS žeton);
 *  - audit nikoli ne zapiše PIN-a, TOTP/recovery kode, skrivnosti ali
 *    otpauth URI-ja (higiena potrjena v testih).
 */

import { db } from '@/lib/db'
import { employeePinFields, timingSafeEqualStr } from '@/lib/auth'
import { consumeRecoveryCode } from '@/lib/mfa'
import { jparse, jstr } from '@/lib/map'
import { rateLimitSharedAsync } from '@/lib/rate-limit'

/* ─────────────── #33 — PIN step-up (sveža potrditev identitete) ─────────────── */

export interface PinStepUpTarget {
  email: string
  pin: string
  pinLookup: string | null
}

/**
 * Sveža PIN reavtentikacija pred občutljivo spremembo MFA (enroll/enable/
 * disable). Ista Primerjava kot prijava: pinLookup (HMAC indeks) s fallbackom
 * na scrypt(pin, email) — oboje timing-safe. Vrne false tudi za prazen PIN
 * (PIN-i so obvezno nastavljeni za prijavo).
 */
export function pinStepUpOk(target: PinStepUpTarget, pin: string): boolean {
  const candidate = String(pin || '')
  if (!candidate) return false
  const expected = employeePinFields(candidate, target.email)
  const byLookup = target.pinLookup
    ? timingSafeEqualStr(target.pinLookup.toLowerCase(), expected.pinLookup)
    : false
  const byPin = target.pin ? timingSafeEqualStr(target.pin, expected.pin) : false
  return byLookup || byPin
}

/* ─────────────── #36 — atomarna zahteva TOTP koraka (RFC 6238 §5.2) ─────────────── */

/**
 * Atomarno (CAS) zapiše uspešno sprejet TOTP korak kot zadnji sprejeti.
 * ENEM stavku UPDATE z pogojem: zmaga samo, če je dosedanji korak nižji
 * (ali še ni nastavljen) → sočasna/ponovna uporaba ISTE kode pade na where
 * (count=0) in klica zavrne caller. Zmagovalna zahteva nadaljuje z izdajo
 * seje; poražena dobi generičen MFA 401 (brez razkritja razloga).
 */
export async function claimTotpCounter(employeeId: string, counter: number): Promise<boolean> {
  if (!Number.isInteger(counter) || counter < 0) return false
  const res = await db.employee.updateMany({
    where: {
      id: employeeId,
      OR: [{ mfaLastTotpCounter: null }, { mfaLastTotpCounter: { lt: counter } }],
    },
    data: { mfaLastTotpCounter: counter },
  })
  return res.count === 1
}

/* ─────────────── #35 — atomarna poraba recovery kode ─────────────── */

export interface RecoveryConsumeResult {
  ok: boolean
  /** CAS konflikt po vseh ponovitvah (sočasna administrativna sprememba) */
  conflict?: boolean
}

/** Zgornja meja CAS ponovitev ( vsaka ponovitev prebere SVEŽ seznam). */
const MAX_CAS_ATTEMPTS = 3

/**
 * Poraba recovery kode kot EN atomaren prehod:
 *  1. preberi svež seznam hash-ev + mfaRecoveryVersion;
 *  2. consumeRecoveryCode (čista logika, isti hashing kot prej);
 *  3. CAS updateMany (where mfaRecoveryVersion == prebrana) — zmaga točno
 *     ena sočasna zahteva; izgubljen CAS ponovno prebere sveže stanje
 *     (koda morda že porabljena → fail-closed 401).
 * Poražena/replay koda nikoli ne izda žetona; ostale kode ostanejo nedotaknjene.
 */
export async function consumeRecoveryCodeAtomic(
  employeeId: string,
  code: string
): Promise<RecoveryConsumeResult> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const emp = await db.employee.findUnique({
      where: { id: employeeId },
      select: { mfaRecoveryCodes: true, mfaRecoveryVersion: true },
    })
    if (!emp) return { ok: false }
    const stored = jparse<string[]>(emp.mfaRecoveryCodes, [])
    const consumed = consumeRecoveryCode(code, stored)
    if (!consumed.ok) return { ok: false } // koda ni (več) prisotna — fail-closed
    const res = await db.employee.updateMany({
      where: { id: employeeId, mfaRecoveryVersion: emp.mfaRecoveryVersion },
      data: {
        mfaRecoveryCodes: jstr(consumed.remaining),
        mfaRecoveryVersion: { increment: 1 },
      },
    })
    if (res.count === 1) return { ok: true }
    // CAS izgubljen — sveža re-iteracija (varno odločanje po issue #35)
  }
  return { ok: false, conflict: true }
}

/* ─────────────── #32 — ločen limit MFA poskusov po računu ─────────────── */

/**
 * Namenski limit za MFA/step-up poskuse po računu (login IP limit ga NE
 * nadomešča — issue #32): 10 poskusov / 5 min. Store-aware (Upstash, če je
 * konfiguriran; sicer bounded memory + vidna napaka ob preklopu).
 */
export async function mfaAttemptRateLimited(accountKey: string): Promise<boolean> {
  const r = await rateLimitSharedAsync(`mfa-acct:${accountKey}`, 10, 300_000)
  return !r.allowed
}
