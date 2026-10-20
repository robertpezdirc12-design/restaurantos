/**
 * Issue #49 (P1) — STREŽNIŠKA politika dokazovanja kartičnega/mobilnega plačila.
 *
 * PREJ je jedro plačila (src/lib/furs/issue.ts) kot zadosten pogoj za card/mobile
 * del plačila zahtevalo SAMO ne-prazen `approvalCode` — vsak niz, ki ga je klient
 * poslal (vključno z `SIM-…` iz brskalniškega simulatorja in poljubno ročno vpisano
 * besedo), je bil zapisan kot `Payment.authorizationCode` in enakovredno veljal
 * kot "dokaz" dokončane transakcije. Odjemalski terminal adapter
 * (src/lib/devices/terminal.ts, 'use client' + localStorage) NI strežniška
 * integracija s ponudnikom plačil — način 'simulator'/'manual' je KONFIGURACIJA
 * KLIENTA in nikoli ne sme spremeniti strežniške politike.
 *
 * Zdaj — profili dokazovanja (PODPRTI):
 *  - 'verified_provider'   — REZERVIRAN za prihodnjo pravo integracijo: strežniško
 *    preverjen rezultat odobrenega ponudnika, vezan na znesek/valuto/merchant/
 *    lokacijo in edinstven provider transaction ID. NOBEN klient danes ne more
 *    zahtevati tega profila — profil se dodeli IZKLJUČNO iz strežniško
 *    preverjenega vira (ko bo integracija obstajala).
 *  - 'manual_attestation'  — ROČNO zabeležena potrditev zaposlenega: delavec je
 *    potrdil na fizičnem terminalu in prepisal kodo. To NI trditev, da je
 *    aplikacija transakcijo preverila pri banki — zapiše se z akterjem in
 *    označenim profilom (audit INVOICE_ISSUE + Payment.authorizationCode).
 *    Lastnik jo lahko IZKLJUČI z env PAYMENTS_ALLOW_MANUAL_ATTESTATION=false
 *    (izrecna odločitev po lokalnem postopku — issue #49 zahteva eksplicitnost).
 *  - 'simulator'           — SIM- predpona (brskalniški terminalni simulator):
 *    veljavna SAMO v strežniško določenem testnem/fiskalnem simulacijskem okolju
 *    (env FURS_ENVIRONMENT / FURS_ALLOW_SIMULATION / Location.fursEnvironment —
 *    nikoli klient). V produkciji → ZAVRNITEV (402).
 *
 * Pravila:
 *  - PAN/CVV se nikoli ne shranjujeta (Payment.authorizationCode nosi samo kodo
 *    odobritve); obstoječi Payment/Receipt/idempotenca/audit/issueFursReceipt
 *    ostajajo kanonični (brez vzporednega plačilnega sistema).
 *  - Dokazovanje je za plačilne dele, ki jih pošlje KLIENT (body.parts /
 *    body.terminal). Deli plačilnih POVEZAV (PayLink) so strežniški vir resnice
 *    za POBRAN delež (status='paid' vrstica iz DB); vendar v1.156.0 jedro tudi
 *    zanje zavrne SIM- odobritev, ko simulacija ni aktivna — vrstica, poravnana
 *    s simulatorjem, v produkciji ne sme postati dokaz plačila.
 */

export type PaymentAttestationProfile = 'verified_provider' | 'manual_attestation' | 'simulator'

/** Simulator odobritvene kode (brskalniški terminal) — SIM- predpona. */
const SIMULATOR_APPROVAL_PREFIX = 'SIM-'

/**
 * Klasifikacija odobritvene kode v profil dokazovanja.
 * Na strežniku: samo SIM- predpona razlikuje simulator; VSA druga ne-prazna koda
 * je (dokler ni prave ponudniške integracije) ročna zabeležba zaposlenega.
 * Profil 'verified_provider' klient ne more doseči s samo kodo.
 */
export function approvalAttestationProfile(approvalCode: string): PaymentAttestationProfile {
  const code = String(approvalCode || '').trim()
  if (code.toUpperCase().startsWith(SIMULATOR_APPROVAL_PREFIX)) return 'simulator'
  return 'manual_attestation'
}

/**
 * Strežniška politika za profil v danem okolju — null = dovoljeno; sicer besedilo
 * zavrnitve (jedro vrne 402).
 *  - simulator izven simulacijskega okolja → zavrnitev (klient ne more ponarediti
 *    produkcijskega plačila z lokalno zastavico);
 *  - manual_attestation ob PAYMENTS_ALLOW_MANUAL_ATTESTATION=false → zavrnitev
 *    (izrecna lastnikova odločitev, da se brez preverjenega ponudnika ne izdaja
 *    računov nad kartičnimi plačili).
 */
export function paymentPolicyError(
  profile: PaymentAttestationProfile,
  simulationActive: boolean
): string | null {
  if (profile === 'simulator' && !simulationActive) {
    return 'Odobritvena koda terminala iz simulatorja ni veljaven dokaz plačila v produkcijskem okolju.'
  }
  if (profile === 'manual_attestation' && process.env.PAYMENTS_ALLOW_MANUAL_ATTESTATION === 'false') {
    return 'Ročna potrditev terminala je onemogočena (PAYMENTS_ALLOW_MANUAL_ATTESTATION=false) — zahtevana je preverjena integracija s ponudnikom.'
  }
  return null
}
