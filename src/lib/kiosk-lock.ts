/**
 * Zaklep kioska — arm/confirm mehanizem (v1.177.0, WCAG 2.1.1).
 *
 * Zaklep terminala je edina pot, s katero postrežec prevzame nadzor nad
 * zaslonom; moral je biti dosegljiv tudi s tipkovnico. Dvoklik (`onDoubleClick`)
 * tiste poti nima — Enter in Space sprožita `click`, nikoli `dblclick` — zato
 * je nadomeščen z dvema ločenima klikoma in vmesnim stanjem, ki ga uporabnik
 * vidi. Čas pride vedno od zunaj (`now`), da je odločanje merjeno brez
 * čakanja in brez brskalnika.
 */

/** Okno med pripravo in potrditvijo. Pod 2 s bi gost terminal zaklenil
 *  pomotoma, nad 5 s pa pripravljenost zastari in postrežec dobi
 *  nedokončano stanje na zaslonu. */
export const LOCK_ARM_WINDOW_MS = 3_000

export type LockPhase = 'idle' | 'armed'

export interface LockState {
  phase: LockPhase
  armedAt: number | null
}

export const initialLockState: LockState = { phase: 'idle', armedAt: null }

/** Pripravljena faza je potekla — gumb se sme vizualno vrniti v idle. */
export function isArmedExpired(state: LockState, now: number): boolean {
  if (state.phase !== 'armed' || state.armedAt === null) return true
  return now - state.armedAt > LOCK_ARM_WINDOW_MS
}

/** En klik na gumb. Drugi klik znotraj okna zaklene; klik po roku pripravi znova. */
export function tapLock(state: LockState, now: number): { next: LockState; lock: boolean } {
  if (state.phase === 'armed' && !isArmedExpired(state, now)) {
    return { next: initialLockState, lock: true }
  }
  return { next: { phase: 'armed', armedAt: now }, lock: false }
}
