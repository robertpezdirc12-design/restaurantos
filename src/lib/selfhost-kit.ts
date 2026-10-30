/**
 * OSS-13 (v1.207.0) — ONE-CLICK PAKIRANJE (Docker/CasaOS za NAS lastnika).
 * docs/GAP-ANALIZA-odprtokodna-konkurenca.md — OrderRestro «one-click install»,
 * CasaOS/ZimaOS distribucija lokalne namestitve.
 *
 * NAMEN: čisti sloj, ki določa KONTRAKT samogostiteljskega paketa (kit) in ga
 * deterministično preverja. Paket je sestavljen iz:
 *   - deploy/Dockerfile          — gradnja slike (bun + Next build, sqlite profil)
 *   - deploy/docker-compose.yml  — ena storitev + nosilec podatkov + vrata
 *   - deploy/docker-entrypoint.sh— preslikava okolja v obstoječi `bun run local`
 *   - deploy/.env.example        — pogodba o spremenljivkah identitete
 *   - docs/SELFHOST-CASAOS.md    — vodnik (CasaOS uvoz, prvi zagon, kopije)
 *
 * ZASNOVANJE (trdo pravilo — NIČ novega izuma):
 *   - zabojnik IZVAJA IZKLJUČNO obstoječi lokalni profil (scripts/local-start.ts),
 *     ki že počne: podatkovna mapa, skrivnosti (config.json), sqlite odjemalec,
 *     dnevna kopija, WAL, `prisma db push`, gradnja po potrebi, zagon Next na
 *     0.0.0.0. Kit je PAKET nad tem profilom, ne vzporedna pot.
 *   - TLS NAMERNO NI del paketa: na NAS-u za HTTPS skrbi CasaOS/ZimaOS ali
 *     obratni posrednik; entrypoint zato `--https` NE posreduje (kontrakt tega
 *     izrecno prepoveduje — glej validateEntrypointContract).
 *   - identiteta obrata (ime, e-pošta, PIN, davčna/matična številka) gre v
 *     zabojnik prek okolja RESTAURANTOS_*, ker brez TLS fronte čarovnik /setup
 *     prevzema ne more prevzeti (dokaz računa fronta) — prvi zagon v zabojniku
 *     je zato OBLIGATORNO prek okolja, ne prek brskalnika.
 *   - 0 uvozov — modul je uporaben v testih, skripti in bodočih orodjih brez
 *     vlečenja odvisnosti (konvencija cron-daily/hourly-email).
 *
 * 0 AI, 0 novih odvisnosti, 0 DDL, 0 novih rut.
 */

/** Notranja vrata aplikacije v zabojniku (zunaj preslika compose). */
export const SELFHOST_INTERNAL_PORT = 3000

/** Nosilec podatkov znotraj zabojnika (baza, skrivnosti, dnevne kopije). */
export const SELFHOST_DATA_DIR = '/data'

/** Predpona slike, ki jo compose zapiše in selfhost-check primerja z APP_VERSION. */
export const SELFHOST_IMAGE_PREFIX = 'restaurantos:'

/** Datoteke paketa — vse MORAJO obstajati (preveri scripts/selfhost-check.ts). */
export const SELFHOST_KIT_FILES = [
  'deploy/Dockerfile',
  'deploy/docker-compose.yml',
  'deploy/docker-entrypoint.sh',
  'deploy/.env.example',
  'docs/SELFHOST-CASAOS.md',
] as const

/** Spremenljivke identitete obrata — vse OPCIJSKE po vrednosti, vse OBVEZNO dokumentirane. */
export const SELFHOST_IDENTITY_ENV = [
  'RESTAURANTOS_NAME',
  'RESTAURANTOS_OWNER_EMAIL',
  'RESTAURANTOS_OWNER_PIN',
  'RESTAURANTOS_TAX_ID',
  'RESTAURANTOS_BUSINESS_ID',
] as const

export type SelfhostIdentityEnv = (typeof SELFHOST_IDENTITY_ENV)[number]

/** Preslikava okolje → zastavica `bun run local` (zrcali deploy/docker-entrypoint.sh). */
export const SELFHOST_ENV_FLAG_MAP: Record<SelfhostIdentityEnv, string> = {
  RESTAURANTOS_NAME: '--restaurant-name',
  RESTAURANTOS_OWNER_EMAIL: '--owner-email',
  RESTAURANTOS_OWNER_PIN: '--owner-pin',
  RESTAURANTOS_TAX_ID: '--tax-id',
  RESTAURANTOS_BUSINESS_ID: '--business-id',
}

/** Vsak najden prekršek je NIZ z razlago — prazna lista = kontrakt izpolnjen. */
export type KitViolation = string

/**
 * Kontrakt deploy/Dockerfile — dobesedni nizi, ki MORAJO obstajati.
 * Namerno pinezamo UKAZE, ne vrstic: build je recept, ne slikopis.
 */
const DOCKERFILE_REQUIRED = [
  { needle: 'FROM oven/bun:', why: 'osnovna slika mora biti pripeta oven/bun (isti runtime kot repo)' },
  { needle: 'bun install --frozen-lockfile --ignore-scripts', why: 'namestitev brez skript (postinstall potrebuje node; generate teče eksplicitno)' },
  { needle: 'node_modules/prisma/build/index.js generate --schema prisma/schema.sqlite.prisma', why: 'sqlite odjemalec se generira eksplicitno (pot iz src/lib/local-setup.ts)' },
  { needle: 'DATABASE_URL=file:', why: 'gradnja potrebuje veljaven sqlite cilj (ograda za SSG)' },
  { needle: 'db push --schema prisma/schema.sqlite.prisma --skip-generate', why: 'ograda pred buildom, da statične strani ne padajo na manjkajoči shemi' },
  { needle: 'node_modules/next/dist/bin/next build', why: 'build prek bun (isti vzorec kot scripts/local-start.ts — node shebang ni na voljo)' },
  { needle: 'RESTAURANTOS_LOCAL=1', why: 'brez standalone izhoda — next start in brez gradnje ob vsakem zagonu' },
  { needle: 'NODE_ENV=production', why: 'produkciski build' },
  { needle: 'EXPOSE 3000', why: 'notranja vrata' },
  { needle: 'HEALTHCHECK', why: 'sonda zdravja' },
  { needle: '/api/health', why: 'sonda meri resnično zdravje (povezava + shema)' },
  { needle: 'USER bun', why: 'zabojnik NE teče kot root' },
  { needle: 'ENTRYPOINT', why: 'vstop je samo prek entrypoint skripte' },
  { needle: 'docker-entrypoint.sh', why: 'entrypoint mora biti kitova skripta' },
] as const

const DOCKERFILE_FORBIDDEN = [
  { needle: '--https', why: 'TLS ni del paketa — na NAS-u ga pokrije CasaOS/obratni posrednik' },
] as const

export function validateDockerfileContract(text: string): KitViolation[] {
  const out: KitViolation[] = []
  for (const r of DOCKERFILE_REQUIRED) {
    if (!text.includes(r.needle)) out.push(`Dockerfile: manjka «${r.needle}» — ${r.why}`)
  }
  for (const r of DOCKERFILE_FORBIDDEN) {
    if (text.includes(r.needle)) out.push(`Dockerfile: prepovedano «${r.needle}» — ${r.why}`)
  }
  return out
}

/** Kontrakt deploy/docker-compose.yml — ena storitev, nosilec, vrata, zdravje. */
const COMPOSE_REQUIRED = [
  { needle: 'services:', why: 'compose razdelek storitev' },
  { needle: 'restaurantos:', why: 'storitev z imenom paketa' },
  { needle: 'build:', why: 'gradnja iz vira (ni registrske slike)' },
  { needle: 'context: ..', why: 'kontekst je koren repozitorija' },
  { needle: 'dockerfile: deploy/Dockerfile', why: 'Dockerfile živi v deploy/' },
  { needle: 'image: restaurantos:', why: 'oznaka slike za sledljivost verzije' },
  { needle: 'ports:', why: 'preslikava vrat' },
  { needle: ':3000"', why: 'zunanja vrata se vežejo na notranjo 3000' },
  { needle: 'restaurantos-data:/data', why: 'imenovan nosilec za /data (baza + kopije + skrivnosti)' },
  { needle: 'restart: unless-stopped', why: 'NAS storitev vstane sama' },
  { needle: 'RESTAURANTOS_LOCAL=1', why: 'lokalni profil tudi v zabojniku' },
  { needle: 'env_file:', why: 'identiteta pride iz .env poleg compose' },
] as const

const COMPOSE_FORBIDDEN = [
  { needle: 'privileged: true', why: 'razširjene pravice niso potrebne in so varnostno nesprejemljive' },
] as const

export function validateComposeContract(text: string): KitViolation[] {
  const out: KitViolation[] = []
  for (const r of COMPOSE_REQUIRED) {
    if (!text.includes(r.needle)) out.push(`compose: manjka «${r.needle}» — ${r.why}`)
  }
  for (const r of COMPOSE_FORBIDDEN) {
    if (text.includes(r.needle)) out.push(`compose: prepovedano «${r.needle}» — ${r.why}`)
  }
  return out
}

/** Kontrakt deploy/docker-entrypoint.sh — preslikava okolja v `bun run local`. */
const ENTRYPOINT_REQUIRED = [
  { needle: '#!/bin/sh', why: 'POSIX lupina (NAS slike nimajo basha)' },
  { needle: 'set -eu', why: 'strogi način — napaka mora ustaviti, ne tiho nadaljevati' },
  { needle: 'bun scripts/local-start.ts', why: 'izvrši obstoječi lokalni profil, brez vzporedne poti' },
  { needle: 'exec "$@"', why: 'izvršitev prek exec (signali dosežejo Next, PID 1 ne ostane lupina)' },
  { needle: '--data-dir', why: 'podatki vedno v nosilec' },
  { needle: '--port 3000', why: 'notranja vrata so pripeta' },
] as const

const ENTRYPOINT_FORBIDDEN = [
  { needle: '--https', why: 'TLS ni del paketa (CasaOS/obratni posrednik ga pokrije)' },
] as const

export function validateEntrypointContract(text: string): KitViolation[] {
  const out: KitViolation[] = []
  for (const r of ENTRYPOINT_REQUIRED) {
    if (!text.includes(r.needle)) out.push(`entrypoint: manjka «${r.needle}» — ${r.why}`)
  }
  for (const env of SELFHOST_IDENTITY_ENV) {
    const flag = SELFHOST_ENV_FLAG_MAP[env]
    if (!text.includes(flag)) out.push(`entrypoint: manjka preslikava ${env} → ${flag}`)
  }
  for (const r of ENTRYPOINT_FORBIDDEN) {
    if (text.includes(r.needle)) out.push(`entrypoint: prepovedano «${r.needle}» — ${r.why}`)
  }
  return out
}

/** Kontrakt deploy/.env.example — vse spremenljivke identitete dokumentirane. */
export function validateEnvExampleContract(text: string): KitViolation[] {
  const out: KitViolation[] = []
  for (const env of SELFHOST_IDENTITY_ENV) {
    if (!text.includes(`${env}=`)) out.push(`env: manjka ${env}= (tudi prazna vrednost mora biti vidna)`)
  }
  return out
}

/** Izvleče oznako slike `restaurantos:x.y.z` iz compose vsebine. */
export function composeImageTag(text: string): string | null {
  const m = text.match(/image:\s*restaurantos:([^\s"]+)/)
  return m?.[1] ?? null
}

/** Izvleče verzijo iz vsebine src/lib/version.ts (enkratna resnica). */
export function versionFromModule(text: string): string | null {
  const m = text.match(/APP_VERSION\s*=\s*'([^']+)'/)
  return m?.[1] ?? null
}
