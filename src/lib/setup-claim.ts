/**
 * v1.180.0 — R3: prevzem prve namestitve iz brskalnika.
 *
 * Ta modul je JEDRO odločitve in nima nobene stranske vezi: ne pozna Prisma,
 * ne `runLocalSetup`, ne HTTP handlerja (sicer bi nastala cikel uvozov, ker
 * `local-setup.ts` rabi `credentialsSheet` od tu). Ruta injicira odvisnosti.
 *
 * ZAKAJ JE OGRAJA PET PLNNA (izmerjeno na drevesu pred to izdajo):
 * aplikacija v lokalnem profilu posluša na 0.0.0.0 in prevzame geslo seje iz
 * glave, ki ji jo nastavi front. Front do te izdaje ni pisal `x-forwarded-for`
 * in se je na Next povezal z `host: '127.0.0.1'` (`local-https-front.ts:61`),
 * zato je vsak klient v LAN za aplikacijo izgledal kot zanka. Pogoj „samo s
 * tega računalnika" torej NE more biti izpeljan iz glave, ki jo poslje klient —
 * od tod `frontTrusted` (HMAC dokaz, ki ga zmore zapisati samo front) in
 * `clientIp` (ki ga front izvleče iz PRAVEGA soketa).
 */
import { createHmac } from 'node:crypto'
import { validateHrOib, validateSiTaxId } from './einvoice-validate'

/** Glava, ki jo sme zapisati izključno lokalna HTTPS front. */
export const FRONT_PROOF_HEADER = 'x-local-front'
/** Glava, ki jo front PREPIŠE z naslovom svojega soketa — klientove vrednosti ne veljajo. */
export const CLIENT_IP_HEADER = 'x-forwarded-for'

/** Isti obrazec kot `runLocalSetup` — namestitev ne sme imeti strožjega pravila kot CLI. */
export const OWNER_EMAIL_RE = /^[^@\s]+@[^@\s]+$/
const PIN_RE = /^\d{4,8}$/
const NAME_MAX = 120
const BUSINESS_ID_MAX = 40

/* ─────────────── kdo sme prevzeti namestitev ─────────────── */

export interface ClaimState {
  /** `DATABASE_URL` se začne z `file:` — sicer gre za oblak, kjer ta pot ne sme teči. */
  localProfile: boolean
  employees: number
  /** Naslov, ki ga je front prebral s svojega soketa (ne iz klientove glave). */
  clientIp: string
  /** Glava fronte se konstantno-časovno ujema s pričakovanim dokazom. */
  frontTrusted: boolean
  rateAllowed: boolean
}

export interface ClaimDecision {
  allowed: boolean
  status: number
  razlog: string
  sporocilo: string
}

/**
 * Zaporedje preverb NI poljubno: najprej profil, nato izvornost zahteve, nato
 * naslov, nato limit, nazadnje zasedenost. TUJI klient torej ne more razbrati
 * števila zaposlenih iz razlike med 403 in 409.
 */
export function claimDecision(s: ClaimState): ClaimDecision {
  if (!s.localProfile) {
    return {
      allowed: false,
      status: 403,
      razlog: 'profil',
      sporocilo:
        'Prevzem namestitve iz brskalnika je na voljo samo v lokalnem profilu (baza je datoteka na tem računalniku). V oblaku ime in davčno številko vneseš v nastavitvah po prijavi.',
    }
  }
  if (!s.frontTrusted) {
    return {
      allowed: false,
      status: 403,
      razlog: 'fronta',
      sporocilo:
        'Zahteva ne prihaja prek lokalne HTTPS fronte. Zaženi `bun run local --https` in čarovnik odpri na naslovu, ki ga zagon izpiše (https://localhost:…).',
    }
  }
  if (!isLoopbackIp(s.clientIp)) {
    return {
      allowed: false,
      status: 403,
      razlog: 'zanka',
      sporocilo:
        'Namestitev lahko prevzame samo brskalnik na tem računalniku. Druge naprave v omrežju do prevzema nimajo dostopa — za njih je namenjena prijava, ne ta pot.',
    }
  }
  if (!s.rateAllowed) {
    return {
      allowed: false,
      status: 429,
      razlog: 'limit',
      sporocilo: 'Preveč poskusov namestitve z tega naslova. Počakaj minuto in poskusi znova.',
    }
  }
  if (s.employees > 0) {
    return {
      allowed: false,
      status: 409,
      razlog: 'zasedeno',
      sporocilo:
        'Namestitev je že prevzeta (v bazi je zaposlenih). Prijavi se s svojo e-pošto in PIN-om; če PIN-a ne poznaš, preberi datoteko PRVIC-ZAGON.txt v podatkovni mapi.',
    }
  }
  return { allowed: true, status: 200, razlog: 'dovoljeno', sporocilo: 'Namestitev je prosta za prevzem.' }
}

/** 127/8, ::1 in preslikana IPv4 (`::ffff:127.x`) sta zanka; vse ostalo ne. */
export function isLoopbackIp(ip: string): boolean {
  const raw = String(ip ?? '').trim().toLowerCase()
  if (!raw) return false
  if (raw === 'localhost' || raw === '::1') return true
  const nizi = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(nizi)
}

/**
 * Dokaz, ki ga front prilepi vsaki zahtevi, klient pa ga ne more sestaviti, ker
 * je HMAC iz `APP_SECRET` in se v brskalnik nikoli ne izroči. Kontekstna beseda
 * je fiksna — dokaz je vezan na namen, ne na splošen secret (enako načelo kot
 * `pinLookup` v `auth.ts`).
 */
export function localFrontProof(appSecret: string): string {
  return createHmac('sha256', String(appSecret ?? ''))
    .update('restaurantos-frontend-claim-v1')
    .digest('hex')
}

/**
 * Isti dve validacijski funkciji kot `parseClaim`, a država se razloči po dolžini,
 * ker terminal o državi ne vpraša. Uporabita ga oba CLI vstopa (`local-setup.ts`
 * in `local-start.ts`) — sicer bi lahko bil isti naslov v brskalniku zavrnjen, v
 * terminalu pa zapisan.
 */
export function validTaxIdByLength(taxId: string): boolean {
  const cizi = String(taxId ?? '').replace(/\s+/g, '')
  return cizi.length === 11 ? validateHrOib(cizi) : validateSiTaxId(cizi)
}

/**
 * KDO določi identiteto obrata: terminal ali brskalnik.
 *
 * Prevzem v brskalniku (§A) zahteva prazno bazo, launcher pa je doslej vedno
 * ustvaril lastnika z privzetim imenom in naključnim PIN-om — s tem je
 * čarovnik samega sebe izključil. Zato velja eno samo pravilo, izrečeno na enem
 * mestu: kadar je zagnana HTTPS fronta in nobena identifikacijska zastavica ni
 * podana, ustvarjanje prepustimo brskalniku. Brez fronte (ali z eksplicitno
 * zastavico) ostane dosedanji potek — nadgradnja obstoječih obratov se ne sme
 * spremeniti.
 */
export function provisionFromTerminal(o: { https: boolean; identityGiven: boolean }): boolean {
  return !o.https || o.identityGiven
}

/* ─────────────── validacija štirih polj ─────────────── */

export interface ClaimFields {
  restaurantName: string
  taxId: string
  businessId: string
  email: string
  pin: string
  country: string
}

export interface ClaimParse {
  ok: boolean
  value: ClaimFields | null
  errors: Record<string, string>
}

/**
 * Merilo: enaka veljavnost kot CLI pot (`--owner-email`, `--owner-pin`) in
 * POSTOJEČI mod 11-10 za davčno številko (`einvoice-validate.ts`). Novih pravil
 * ne izmišljamo; neznan ključ iz telesa se zavrže, napaka pa nikoli ne ponovi
 * vpisanega PIN-a.
 */
export function parseClaim(body: unknown): ClaimParse {
  const errors: Record<string, string> = {}
  const telo = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  const niz = (k: string): string => (typeof telo[k] === 'string' ? (telo[k] as string).trim() : '')

  const restaurantName = niz('restaurantName')
  if (!restaurantName) errors.restaurantName = 'Ime obrata je obvezno.'
  else if (restaurantName.length > NAME_MAX) errors.restaurantName = `Ime obrata lahko šteje največ ${NAME_MAX} znakov.`

  const email = niz('email').toLowerCase()
  if (!email) errors.email = 'E-pošta lastnika je obvezna.'
  else if (!OWNER_EMAIL_RE.test(email)) errors.email = 'E-pošta nima veljavne oblike (npr. lastnik@obrt.si).'

  const pin = niz('pin')
  if (!pin) errors.pin = 'PIN je obvezen.'
  else if (!PIN_RE.test(pin)) errors.pin = 'PIN mora imeti 4–8 števk.'

  const country = (niz('country') || 'SI').toUpperCase()
  const taxId = niz('taxId').replace(/\s+/g, '')
  if (taxId) {
    const veljavna = country === 'HR' ? validateHrOib(taxId) : validateSiTaxId(taxId)
    if (!veljavna) {
      errors.taxId =
        country === 'HR'
          ? 'OIB mora imeti 11 števk in pravilno kontrolno števko.'
          : 'Davčna številka mora imeti 8 števk in pravilno kontrolno števko.'
    }
  }

  const businessId = niz('businessId')
  if (businessId.length > BUSINESS_ID_MAX) errors.businessId = `Matična številka lahko šteje največ ${BUSINESS_ID_MAX} znakov.`

  if (Object.keys(errors).length > 0) return { ok: false, value: null, errors }
  return { ok: true, value: { restaurantName, taxId, businessId, email, pin, country }, errors }
}

/* ─────────────── poverilnice: en vir, dva izpisa ─────────────── */

export interface CredentialSheetInput {
  restaurantName: string
  ownerEmail: string
  dataDir: string
  dbPath: string
  taxId?: string
  businessId?: string
  pin?: string
  /**
   * `reveal` sme uporabiti IZKLJUČNO zapis na disk (datoteka je 0600 in je edino
   * okrevanje dostopa). Za brskalnik ostane izpust prazen — sled se tiska in
   * pusti na pultu, PIN pa je geslo do celega obrata.
   */
  pinMode?: 'reveal' | 'withhold'
}

/**
 * Besedilo brez časovnega žiga: odgovor rute se byte-for-byte primerja s
 * poverilnicami na disku (`v180` C10), prav tako pa sme ostati determiniran, da
 * ponovni zagon ne prepisuje že zapisane datoteke.
 */
export function credentialsSheet(i: CredentialSheetInput): string {
  const vrstice = [
    'RestaurantOS — poverilnice prve namestitve',
    '',
    `Obrat: ${i.restaurantName}`,
  ]
  if (i.taxId) vrstice.push(`Davčna številka: ${i.taxId}`)
  if (i.businessId) vrstice.push(`Matična številka: ${i.businessId}`)
  vrstice.push(
    '',
    `Podatkovna mapa: ${i.dataDir}`,
    `Baza: ${i.dbPath}`,
    '',
    `Prijava: ${i.ownerEmail}`,
  )
  if (i.pinMode === 'reveal' && i.pin) vrstice.push(`PIN: ${i.pin}`)
  else vrstice.push('PIN: namenoma ni izpisan — to sled je mogoče natisniti in pustiti na pultu.')
  vrstice.push(
    '',
    'Če PIN-a ne poznaš, ga preberi iz datoteke PRVIC-ZAGON.txt v podatkovni mapi (pravice 0600) in jo uniči, ko si PIN zapomniš.',
    'Nobene demo poverilnice niso bile ustvarjene.',
    '',
  )
  return vrstice.join('\n')
}
