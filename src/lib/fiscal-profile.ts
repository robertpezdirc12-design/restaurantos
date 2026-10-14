/**
 * Issue #53 (P0/P1) — STREŽNIŠKI fiskalni profil (fail-closed).
 *
 * PREJ (src/lib/furs/issue.ts + receipts/[id]/storno — duplirano):
 *   const fursEnv = process.env.FURS_ENVIRONMENT || location.fursEnvironment || 'simulation'
 *   const simulation = process.env.FURS_ALLOW_SIMULATION === 'true'
 *     || ['simulation', 'test'].includes(fursEnv.toLowerCase())
 * posledice (fail-OPEN v produkcijskem runtime-u):
 *   - manjkajoča konfiguracija (globalni env + lokacija oba prazna) → privzeta
 *     vrednost 'simulation' → račun z fiscalVerified: true / fiscalStatus 'verified'
 *     in simuliranimi kodami, kot da bi bil uradno fiskaliziran;
 *   - FURS_ALLOW_SIMULATION='true' PRISILI simulacijo tudi ob FURS_ENVIRONMENT='production';
 *   - tipografska napaka (npr. 'prod') tiho postane "produkcija" (simulation=false,
 *     brez certifikata → pending) namesto jasne konfiguracijske napake.
 *
 * Zdaj — EKSPPLICITNI strežniški profili (runbook docs/FURS-CERT-RUNBOOK.md):
 *   1. development/test   — nabor: karkoli razen NODE_ENV=production (dev, bun test);
 *                           manjkajoči env → privzeta simulacija (obstoječe vedenje).
 *   2. produkcija/testni  — NODE_ENV=production + izrecen FURS_ENVIRONMENT/Location.
 *                           fursEnvironment='test' (uradna testna napoved; kodni tok
 *                           ostaja simulacijski kot doslej — SOAP se pokliče samo s
 *                           certifikatom v produkcijskem profilu). Odgovor izrecno
 *                           označi okolje 'test' (nikoli kot živ produkcijski uspeh).
 *   3. produkcija/live    — NODE_ENV=production + env='production' (+ certifikat).
 *
 * Fail-closed PRAVILA (NODE_ENV=production):
 *   - env popolnoma manjka (global + lokacija) → FISCAL_CONFIG_MISSING (503) —
 *     PRED ustvarjanjem Payment/Receipt/StockTransaction;
 *   - env 'simulation' → FISCAL_SIMULATION_IN_PRODUCTION (503), RAZEN če lastnik
 *     IZRECNO odobri testni način z namensko varovalko FURS_PRODUCTION_TEST_MODE
 *     ='true' (dokumentirana, namenska odločitev);
 *   - FURS_ALLOW_SIMULATION='true' OB env='production' → FISCAL_SIMULATION_IN_
 *     PRODUCTION (503) — zastavica ne sme PRISILITI simulacije nad produkcijskim
 *     okoljem (to je bil dejanski fail-open vektor); nad izrecnim 'test' profilom
 *     je zastavica redundančna → izdaja poteka ( okolje 'test' je že simulacijsko
 *     po deklaraciji lastnika), v logih pa gre opozorilo, naj jo odstrani;
 *   - neveljavna vrednost env (typo) → FISCAL_CONFIG_INVALID (503) — v VSEH
 *     runtimeih (konfiguracijska napaka se ne sme tiho pretvoriti v produkcijo).
 *
 * KODOVNA POTEKLA ISTA KOT DOSLEJ (§18 — brez spremembe vedenja simulatorja):
 * 'test' in 'simulation' ostajata simulacijska (simulirane kode, brez SOAP klica,
 * fiscalStatus 'verified' ob uspehu) — razlika je IZRECNA OZNAKA okolja v odgovoru
 * (fursEnvironment: 'test' | 'simulation') in reviziji INVOICE_ISSUE, tako poročila/
 * izpisi lahko razločijo testni od produkcijskega verified statusa (issue #53 §4).
 */

/** Kanonične vrednosti fiskalnega okolja (globalni env IN Location.fursEnvironment). */
export type FiscalEnvironment = 'production' | 'test' | 'simulation'

const VALID_ENVIRONMENTS: readonly FiscalEnvironment[] = ['production', 'test', 'simulation']

/** Od kod je profil razrešen (revizija/diagnostika). */
export type FiscalProfileSource = 'global' | 'location' | 'default'

export interface FiscalProfile {
  /** Učinkovito okolje (izrecno razrešeno — nikoli ' kar privzetek v produkciji). */
  environment: FiscalEnvironment
  /**
   * Kodni tok simulacije (test + simulation → simulirane kode, brez SOAP — obstoječe
   * vedenje). V produkciji dosegljiv SAMO z izrecnim env='test'/'simulation'
   * (productionTestMode) — privzeto izključen.
   */
  simulation: boolean
  /** Vir razrešitve: globalni env ima prednost pred lokacijo (kot prej). */
  source: FiscalProfileSource
  /** NODE_ENV === 'production'. */
  productionRuntime: boolean
  /** Lastnikova namenska varovalka FURS_PRODUCTION_TEST_MODE='true'. */
  productionTestMode: boolean
}

/** Napaka konfiguracije → 503 z varnim sporočilom (brez vrednosti skrivnosti). */
export class FiscalConfigError extends Error {
  readonly status = 503
  readonly code:
    | 'FISCAL_CONFIG_MISSING'
    | 'FISCAL_SIMULATION_IN_PRODUCTION'
    | 'FISCAL_CONFIG_INVALID'

  constructor(code: FiscalConfigError['code'], message: string) {
    super(message)
    this.name = 'FiscalConfigError'
    this.code = code
  }
}

function normalizeEnvValue(raw: string | null | undefined): string {
  return String(raw ?? '').trim().toLowerCase()
}

/**
 * Razreši strežniški fiskalni profil. META: vrže FiscalConfigError ob kršitvi
 * fail-closed pravil (klicatelj preslika na 503). Vsa logika je ČISTA (brez DB)
 * — testabilna v tests/issue53-54-fiscal-po-scope.test.ts.
 */
export function resolveFiscalProfile(input: {
  globalEnv?: string | null
  locationEnv?: string | null
  allowSimulation?: string | null
  productionTestMode?: string | null
  nodeEnv?: string | null
}): FiscalProfile {
  const productionRuntime = String(input.nodeEnv ?? '').trim().toLowerCase() === 'production'
  const productionTestMode = String(input.productionTestMode ?? '').trim().toLowerCase() === 'true'
  const allowSimulation = String(input.allowSimulation ?? '').trim().toLowerCase() === 'true'

  const globalEnv = normalizeEnvValue(input.globalEnv)
  const locationEnv = normalizeEnvValue(input.locationEnv)

  // veljavnost VREDNOSTI (typo se ne sme tiho pretvoriti v produkcijo) — vsak runtime
  for (const [value, source] of [
    [globalEnv, 'FURS_ENVIRONMENT'],
    [locationEnv, 'Location.fursEnvironment'],
  ] as const) {
    if (value && !VALID_ENVIRONMENTS.includes(value as FiscalEnvironment)) {
      throw new FiscalConfigError(
        'FISCAL_CONFIG_INVALID',
        `Fiskalna konfiguracija je neveljavna: ${source}="${value}" — dovoljene vrednosti: production, test, simulation.`,
      )
    }
  }

  // razrešitev: globalni env ima prednost pred lokacijo (obstoječa prednostnost)
  let environment: FiscalEnvironment
  let source: FiscalProfileSource
  if (globalEnv) {
    environment = globalEnv as FiscalEnvironment
    source = 'global'
  } else if (locationEnv) {
    environment = locationEnv as FiscalEnvironment
    source = 'location'
  } else if (productionRuntime) {
    // Issue #53 §2: produkcija BREZ izrecnega okolja → fail-closed (503) —
    // NIKOLI več privzeta simulacija z lažnim 'verified' statusom.
    throw new FiscalConfigError(
      'FISCAL_CONFIG_MISSING',
      'Fiskalno okolje ni nastavljeno (FURS_ENVIRONMENT / fursEnvironment lokacije) — produkcija zahteva izrecno konfiguracijo. Nastavite FURS_ENVIRONMENT=production (ali test) ali dodajte FURS_PRODUCTION_TEST_MODE=true za namenski testni način.',
    )
  } else {
    // development/test runtime: privzeta simulacija (obstoječe dev vedenje, §18)
    environment = 'simulation'
    source = 'default'
  }

  // Issue #53 §3: v produkciji je simulacija IZKLJUČENA (varno privzeto) —
  // zavrnemo env='simulation' ter FURS_ALLOW_SIMULATION, ki bi PRISILIL simulacijo
  // nad (produkcijskim) okoljem 'production' (fail-open vektor: zastavica ob
  // FURS_ENVIRONMENT=production je izdajala simulirane račune kot 'verified').
  // Nad IZRECNIM testnim profilom ('test') je zastavica REDUNDANTNA (okolje je
  // že simulacijsko po lastnikovi deklaraciji — dokazano produkcija stanje:
  // lokacija 'test' + zastavica): ne blokira izdaje, a opozori lastniku v logih.
  // Varovalka FURS_PRODUCTION_TEST_MODE ostaja rezervirana za env 'simulation'.
  if (productionRuntime && !productionTestMode) {
    if (environment === 'simulation') {
      throw new FiscalConfigError(
        'FISCAL_SIMULATION_IN_PRODUCTION',
        'Fiskalna simulacija je v produkciji izključena (FURS_ENVIRONMENT="simulation") — računov s simuliranimi kodami in "verified" statusom ni mogoče izdajati. Nastavite FURS_ENVIRONMENT=production oz. test, ali FURS_PRODUCTION_TEST_MODE=true za namenski testni način.',
      )
    }
    if (allowSimulation && environment === 'production') {
      throw new FiscalConfigError(
        'FISCAL_SIMULATION_IN_PRODUCTION',
        'FURS_ALLOW_SIMULATION=true ne sme prisiliti simulacije nad produkcijskim okoljem (FURS_ENVIRONMENT=production) — računi bi bili simulirani, a označeni verified. Odstranite zastavico ali nastavite FURS_PRODUCTION_TEST_MODE=true za namenski testni način.',
      )
    }
    if (allowSimulation) {
      // redundančna zastavica nad izrecnim 'test' profilom — ne blokira izdaje
      // (okolje je že simulacijsko po lastnikovi deklaraciji), a opozori v logih
      console.warn(
        '[fiscal-profile] FURS_ALLOW_SIMULATION=true je v produkciji redundančen nad izrecnim okoljem "test" — priporočamo odstranitev zastavice (FURS_ENVIRONMENT/lokacija že določata testni profil).',
      )
    }
  }

  // kodni tok (obstoječa semantika): test/simulation = simulirane kode; allowSimulation
  // vpriliči simulacijo (v produkciji dosegljiv samo prek productionTestMode)
  const simulation = environment !== 'production' || allowSimulation

  return { environment, simulation, source, productionRuntime, productionTestMode }
}
