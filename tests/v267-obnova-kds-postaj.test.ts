/**
 * v1.267.0 — OBNOVA NASTAVITEV KDS POSTAJ
 * (docs/PRIMERJAVA-VMESNIKOV-2026 §41; Lightspeed julij 2026
 * »Restore KDS stations in seconds« — »select the station name, and KDS
 * applies the latest saved settings«).
 *
 * Izmerjena vrzel (§41 A): VSE nastavitve KDS zaslona so bile PER NAPRAVA
 * v localStorage (sedem ro_kds_* ključev — pragovi Issue #74 V-3, pisava
 * V-8, gostota V-8, stolpci V-8, pogled V-9, zaklep §18 B, vrstni red
 * §38). Obrezena/zamenjana tablica je izgubila CELOTNO konfiguracijo.
 *
 * Določitev Ž12: profil PO POSTAJI na strežniku (Integration vrstica
 * kds-station-profile, PER LOKACIJA, 0 DDL); SVEŽA naprava (noben
 * ro_kds_* ključ) ob izbiri postaje SAMODEJNO obnovi zadnji profil;
 * naprava z uporabniškimi spremembami (touched) samodejne obnove NE
 * dobi — njegova izbira vedno zmaga; ročna Shrani/Obnovi vedno na voljo.
 *
 *  Č1 · ČISTI SLOJ (kds-station-profile.ts): sanitize veljavnih/
 *    neveljavnih polj, pragovi monotonost, savedAt/savedBy, mapa
 *    (neveljavni ključi, meja 64), station key regularnost, vsebinski
 *    podpis, seznam LS ključev.
 *  Č2 · API + MONTAŽA: GET/PUT + kitchen.update + orgScope; 400
 *    validacija NAJPREJ; merge + revizija; Integration nosilec; sveža
 *    naprava snapshot; nalaganje perms-gated; samodejna obnova pogojni
 *    efekt; touched zastavici; applyKdsProfile; Popover sekcija; save
 *    handler.
 *  Ž · REGISTRI: verzija 1.267.0, i18n pariteta 4320/4320 (+11 ključev),
 *    dokument §41 + AUDIT POSODOBITEV, worklog Task ID.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  KDS_STATION_PROFILE_MARKER,
  KDS_PROFILE_MAX_STATIONS,
  KDS_PROFILE_LS_KEYS,
  isValidProfileStationKey,
  sanitizeKdsStationProfile,
  sanitizeKdsProfileMap,
  kdsProfileContentSig,
  defaultKdsStationProfile,
} from '../src/lib/kds-station-profile'
import { KDS_AGE_DEFAULTS } from '../src/lib/kds-delays'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// ── Č1) ČISTI SLOJ (kds-station-profile.ts) ──

describe('v1.267.0 Č1 — kds-station-profile (čisti sloj)', () => {
  test('Č1a: veljaven profil povsem ohranjen (vsa polja)', () => {
    const p = sanitizeKdsStationProfile({
      fontSize: 'XL', density: 'normal', columns: 8, view: 'list',
      viewOnly: true, ageThresholds: { warn: 5, urgent: 10, late: 20 },
      ticketOrder: 'manual', savedAt: '2026-11-06T10:00:00.000Z', savedBy: 'Katarina Kuhinja',
    })
    expect(p).toEqual({
      fontSize: 'XL', density: 'normal', columns: 8, view: 'list',
      viewOnly: true, ageThresholds: { warn: 5, urgent: 10, late: 20 },
      ticketOrder: 'manual', savedAt: '2026-11-06T10:00:00.000Z', savedBy: 'Katarina Kuhinja',
    })
  })

  test('Č1b: neveljavna polja padejo na privzete vrednosti naprave (fail-closed)', () => {
    const p = sanitizeKdsStationProfile({
      fontSize: 'XX', density: 'gost', columns: 7, view: 'grid',
      viewOnly: 'yes', ticketOrder: 'auto', ageThresholds: 'hitro',
    })
    expect(p.fontSize).toBe('M')
    expect(p.density).toBe('compact')
    expect(p.columns).toBe(6)
    expect(p.view).toBe('columns')
    expect(p.viewOnly).toBe(false)
    expect(p.ticketOrder).toBe('default')
    expect(p.ageThresholds).toEqual({ ...KDS_AGE_DEFAULTS })
    // viewOnly je STROGO boolean true — niz 'yes' ne zadostuje
    expect(sanitizeKdsStationProfile({ viewOnly: 1 }).viewOnly).toBe(false)
    expect(sanitizeKdsStationProfile({ viewOnly: true }).viewOnly).toBe(true)
    // null/undefined/niz/array vhod → celoten privzeti profil
    for (const raw of [null, undefined, 'napaka', 42, [1, 2]]) {
      expect(sanitizeKdsStationProfile(raw)).toEqual(defaultKdsStationProfile())
    }
  })

  test('Č1c: pragovi nemonoton → privzeti (ista disciplina kot normalizeKdsAgeThresholds)', () => {
    // 10 ≥ 15 krši warn < urgent < late
    const p = sanitizeKdsStationProfile({ ageThresholds: { warn: 10, urgent: 10, late: 20 } })
    expect(p.ageThresholds).toEqual({ ...KDS_AGE_DEFAULTS })
    // veljavni monotoni ostanejo
    const ok = sanitizeKdsStationProfile({ ageThresholds: { warn: 3, urgent: 7, late: 12 } })
    expect(ok.ageThresholds).toEqual({ warn: 3, urgent: 7, late: 12 })
  })

  test('Č1d: savedAt/savedBy — prazni/manjkajoči padejo na argumente (API vedno zapiše sveža)', () => {
    const withDefaults = sanitizeKdsStationProfile({ fontSize: 'L' }, '2026-11-06T12:00:00.000Z', 'Ana Admin')
    expect(withDefaults.savedAt).toBe('2026-11-06T12:00:00.000Z')
    expect(withDefaults.savedBy).toBe('Ana Admin')
    // prazni nizi v telesu NE zadostijo ( API-jev ISO čas in ime vedno zmagata)
    const empty = sanitizeKdsStationProfile({ savedAt: '', savedBy: '' }, 'iso', 'ime')
    expect(empty.savedAt).toBe('iso')
    expect(empty.savedBy).toBe('ime')
    // ne-niz vrednosti tudi padejo na argumente
    const nonStr = sanitizeKdsStationProfile({ savedAt: 123, savedBy: null }, 'iso2', 'ime2')
    expect(nonStr.savedAt).toBe('iso2')
    expect(nonStr.savedBy).toBe('ime2')
  })

  test('Č1e: sanitizeKdsProfileMap — neveljavni ključi izpadejo; niz/array/null → {}; meja 64', () => {
    expect(sanitizeKdsProfileMap(null)).toEqual({})
    expect(sanitizeKdsProfileMap('x')).toEqual({})
    expect(sanitizeKdsProfileMap([1])).toEqual({})
    const m = sanitizeKdsProfileMap({
      KITCHEN: { fontSize: 'L' },
      'sladica-postaja': { fontSize: 'S' },
      'ne veljavno!': { fontSize: 'XL' },
      '': { fontSize: 'XL' },
    })
    expect(Object.keys(m).sort()).toEqual(['KITCHEN', 'sladica-postaja'])
    expect(m.KITCHEN.fontSize).toBe('L')
    // meja 64: 65. postaja (po vrsti vstavljanja) izpade
    const big: Record<string, unknown> = {}
    for (let i = 0; i < 70; i++) big[`st-${i}`] = { fontSize: 'M' }
    expect(Object.keys(sanitizeKdsProfileMap(big)).length).toBe(KDS_PROFILE_MAX_STATIONS)
  })

  test('Č1f: isValidProfileStationKey — regularnost ?station= inicializatorja', () => {
    expect(isValidProfileStationKey('ALL')).toBe(true)
    expect(isValidProfileStationKey('KITCHEN')).toBe(true)
    expect(isValidProfileStationKey('BAR')).toBe(true)
    expect(isValidProfileStationKey('zivila-zar-01')).toBe(true)
    expect(isValidProfileStationKey('')).toBe(false)
    expect(isValidProfileStationKey('ne veljavno')).toBe(false)
    expect(isValidProfileStationKey('šumnik')).toBe(false)
    expect(isValidProfileStationKey(`predolg-${'x'.repeat(70)}`)).toBe(false)
    expect(isValidProfileStationKey(42)).toBe(false)
  })

  test('Č1g: kdsProfileContentSig — savedAt/savedBy izpuščena (gumb shrani ostane omogočen tudi ob istih nastavitvah)', () => {
    const a = sanitizeKdsStationProfile({ fontSize: 'L' }, '2026-01-01T00:00:00.000Z', 'Ana')
    const b = sanitizeKdsStationProfile({ fontSize: 'L' }, '2026-11-06T00:00:00.000Z', 'Bor')
    expect(kdsProfileContentSig(a)).toBe(kdsProfileContentSig(b))
    const c = sanitizeKdsStationProfile({ fontSize: 'XL' }, '2026-11-06T00:00:00.000Z', 'Bor')
    expect(kdsProfileContentSig(a)).not.toBe(kdsProfileContentSig(c))
  })

  test('Č1h: KDS_PROFILE_LS_KEYS — sedem ključev Issue #74/§18 B/§38 družine', () => {
    expect(KDS_PROFILE_LS_KEYS.length).toBe(7)
    for (const k of KDS_PROFILE_LS_KEYS) expect(k.startsWith('ro_kds_')).toBe(true)
    expect(KDS_PROFILE_LS_KEYS).toContain('ro_kds_age_thresholds')
    expect(KDS_PROFILE_LS_KEYS).toContain('ro_kds_font_size')
    expect(KDS_PROFILE_LS_KEYS).toContain('ro_kds_density')
    expect(KDS_PROFILE_LS_KEYS).toContain('ro_kds_columns')
    expect(KDS_PROFILE_LS_KEYS).toContain('ro_kds_view')
    expect(KDS_PROFILE_LS_KEYS).toContain('ro_kds_view_only')
    expect(KDS_PROFILE_LS_KEYS).toContain('ro_kds_ticket_order')
  })
})

// ── Č2) API + MONTAŽA ──

describe('v1.267.0 Č2 — API + UI montaža', () => {
  test('Č2a: ruta /api/kitchen/profile — GET/PUT + kitchen.update + GLOBALNA vrstica (E2E najdba #1)', () => {
    const route = read('src/app/api/kitchen/profile/route.ts')
    expect(route).toContain("requirePermission(req, 'kitchen.update')")
    expect(route).toContain('export async function GET')
    expect(route).toContain('export async function PUT')
    // E2E najdba #1: pacing-vzorec (per lokacija + requireUserLocation) je centralnemu
    // uporabniku na več lokacijah vrnil 400 brez poti — GLOBALNA vrstica (vzorec auto86)
    expect(route).toContain('GLOBALNA Integration vrstica')
    expect(route).toContain('vzorec auto86 v1.230.0 / kiosk-upsell')
    // trditve odsotnosti ciljajo Klice, ne besede (lekcija v259 #3 — pacing
    // vzorec je omenjen v dokumentacijskem komentarju, KLIČA pa ni)
    expect(route).not.toContain('await requireUserLocation(')
    expect(route).not.toContain('await assertOrgScope(')
    expect(route).not.toContain('resolveProfileLocation')
  })

  test('Č2b: PUT validacija — postaja NAJPREJ (400), profile obvezen objekt', () => {
    const route = read('src/app/api/kitchen/profile/route.ts')
    expect(route).toContain('isValidProfileStationKey(body.station)')
    expect(route).toContain('Neveljaven klju\u010d postaje')
    expect(route).toContain('Array.isArray(body.profile)')
    // meja 64 = 400 (varovalo rasti, iskreno sporočilo)
    expect(route).toContain('KDS_PROFILE_MAX_STATIONS')
    expect(route).toContain('Dose\u017eena zgornja meja profilov postaj')
  })

  test('Č2c-pre: loadMap RAZČLENI config niz (E2E najdba #2 — sanitize zavrže ne-objekt)', () => {
    const route = read('src/app/api/kitchen/profile/route.ts')
    // config stolpec Integration je String (JSON tekst) — brez jparse/JSON.parse je
    // sanitizeKdsProfileMap(row.config) VEDNO {} (typeof niz !== 'object') in profil
    // tiho izgine po shranjevanju (najdeno z agent-browser E2E, ne s suite)
    expect(route).toContain('sanitizeKdsProfileMap(jparse<unknown>(row?.config, null))')
    // enaka disciplina kot pacing (parsePacingConfig) in kiosk-upsell (jparse)
  })

  test('Č2c: PUT merge ene postaje + revizija KDS_STATION_PROFILE_SAVED', () => {
    const route = read('src/app/api/kitchen/profile/route.ts')
    // merge: obstoje\u010d zemljevid se prebere in raz\u0161iri (dve tablici ne povozi ta druga)
    expect(route).toContain('const merged = { ...existing, [station]: next }')
    // sanitizacija \u010distega sloja nad celim zemljevidom ob branju
    expect(route).toContain('sanitizeKdsProfileMap(jparse<unknown>(row?.config, null))')
    // revizija z before/after
    expect(route).toContain('KDS_STATION_PROFILE_SAVED')
    expect(route).toContain('jstr({ station, from: prev, to: next, by: user.name })')
  })

  test('Č2d: Integration nosilec — marker, type other, GLOBALNA (brez locationId), 0 DDL', () => {
    const route = read('src/app/api/kitchen/profile/route.ts')
    expect(route).toContain("name: KDS_STATION_PROFILE_MARKER, type: 'other'")
    // create BREZ locationId — globalna vrstica (vzorec auto86/kiosk-upsell)
    const createIdx = route.indexOf('await db.integration.create({')
    const createBlock = route.slice(createIdx, createIdx + 420)
    expect(createBlock).not.toContain('locationId')
    // NOVA DDL vrstica NE obstaja — nosilec je obstoječa Integration tabela
    expect(read('src/lib/kds-station-profile.ts')).toContain("export const KDS_STATION_PROFILE_MARKER = 'kds-station-profile'")
    const sqlite = read('prisma/schema.sqlite.prisma')
    const main = read('prisma/schema.prisma')
    expect(sqlite).not.toContain('KdsStationProfile')
    expect(main).not.toContain('KdsStationProfile')
  })

  test('Č2e: dashboard — snapshot SVEŽE naprave v hidracijski mikrotaski', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain('kdsProfileFreshRef.current = !KDS_PROFILE_LS_KEYS.some((k) => localStorage.getItem(k) !== null)')
  })

  test('Č2f: dashboard — nalaganje profilov perms-gated (kitchen.update, enkrat, brez locationId)', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain("if (!mg && !pm.includes('kitchen.update')) return")
    expect(page).toContain("api<{ profiles?: Record<string, KdsStationProfile> }>('/api/kitchen/profile')")
  })

  test('Č2g: dashboard — samodejna obnova pogojni efekt (sve\u017ea + nedotaknjena + neraz\u0161irjena + obstaja)', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain('if (!kdsProfileFreshRef.current || kdsUserTouchedRef.current) return')
    expect(page).toContain('if (kdsAutoRestoredRef.current.has(kdsStation)) return')
    // CI lint najdba: aplikacija teče v MIKROTASKI (react-hooks/set-state-in-effect
    // — isti vzorec kot hidracijska mikrotakta; sinhroni setState v efektu je padel CI)
    expect(page).toContain("queueMicrotask(() => applyKdsProfile(p, 'kds.profileAuto'))")
  })

  test('Č2h: dashboard — touched zastavica v OBEH uporabniških poteh (kdsPersist + pragovi)', () => {
    const page = read('src/app/dashboard/page.tsx')
    // persist pokriva vse preklopnike: pisava/gostota/stolpci/pogled/zaklep/vrstni red
    const persistIdx = page.indexOf('const kdsPersist = (key: string, value: string) => {')
    const persistBlock = page.slice(persistIdx, persistIdx + 260)
    expect(persistBlock).toContain('kdsUserTouchedRef.current = true')
    // pragovi imajo svojo pot (kdsSaveAgeThresholds — direkten setItem)
    const ageIdx = page.indexOf('const kdsSaveAgeThresholds = (th: KdsAgeThresholds) => {')
    const ageBlock = page.slice(ageIdx, ageIdx + 260)
    expect(ageBlock).toContain('kdsUserTouchedRef.current = true')
    // applyKdsProfile NE postavi touched (obnova ni uporabni\u0161ka sprememba)
    const applyIdx = page.indexOf('const applyKdsProfile = useCallback')
    const applyBlock = page.slice(applyIdx, applyIdx + 900)
    expect(applyBlock).not.toContain('kdsUserTouchedRef.current = true')
  })

  test('Č2i: applyKdsProfile — aplicira VSE nastavitve + zapi\u0161e localStorage (isti klju\u010di kot hidracija)', () => {
    const page = read('src/app/dashboard/page.tsx')
    const applyIdx = page.indexOf('const applyKdsProfile = useCallback')
    const applyBlock = page.slice(applyIdx, applyIdx + 1200)
    for (const setter of ['setKdsFontSize', 'setKdsDensity', 'setKdsColumns', 'setKdsView', 'setKdsViewOnly', 'setKdsTicketOrder', 'setKdsAgeTh']) {
      expect(applyBlock).toContain(setter)
    }
    for (const key of ['ro_kds_font_size', 'ro_kds_density', 'ro_kds_columns', 'ro_kds_view', 'ro_kds_view_only', 'ro_kds_ticket_order']) {
      expect(applyBlock).toContain(`localStorage.setItem('${key}'`)
    }
    expect(applyBlock).toContain('KDS_AGE_THRESHOLD_LS_KEY, JSON.stringify(p.ageThresholds)')
  })

  test('Č2j: Popover sekcija — gumba, aria z imenom postaje, obstoje\u010di profil, disabled brez', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain("t('kds.profileTitle')")
    expect(page).toContain("t('kds.profileSave')")
    expect(page).toContain("t('kds.profileRestore')")
    expect(page).toContain("t('kds.profileSaveAria'")
    expect(page).toContain("t('kds.profileRestoreAria'")
    expect(page).toContain("t('kds.profileExisting'")
    // gumb Obnovi onemogo\u010den brez profila za trenutno postajo
    expect(page).toContain('disabled={kdsProfileBusy || !kdsProfiles[kdsStation]}')
    // shranjevanje vedno omogo\u010deno (contentSig izpu\u0161\u010da \u010das — isto vsebino sme prepisati)
    expect(page).toContain('disabled={kdsProfileBusy}')
  })

  test('Č2k: save handler — PUT z izbrano postajo (kdsStationRef mirror) + toasti', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain("body: JSON.stringify({ station: kdsStationRef.current, profile })")
    expect(page).toContain("t('kds.profileSaved')")
    expect(page).toContain("t('kds.profileSaveFail')")
    expect(page).toContain('const res = await api<{ profiles?: Record<string, KdsStationProfile> }>(\'/api/kitchen/profile\', {')
  })
})

// ── Ž) REGISTRI ──

describe('v1.267.0 Ž — registri', () => {
  test('Ž1: verzija 1.267.0 (version.ts + compose)', () => {
    expect(APP_VERSION).toBe('1.302.0')
    expect(read('src/lib/version.ts')).toContain("'1.302.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.302.0')
  })

  test('Ž2: i18n pariteta SL/HR 4320/4320 (+11 klju\u010dev vala)', () => {
    for (const k of [
      'kds.profileTitle', 'kds.profileHint', 'kds.profileExisting', 'kds.profileSave',
      'kds.profileRestore', 'kds.profileSaveAria', 'kds.profileRestoreAria',
      'kds.profileSaved', 'kds.profileRestored', 'kds.profileAuto', 'kds.profileSaveFail',
    ]) {
      expect(sl[k]).toBeTruthy()
      expect(hr[k]).toBeTruthy()
    }
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('Ž3: dokument §41 + AUDIT POSODOBITEV v1.267.0', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 41.')
    expect(doc).toContain('OBNOVA NASTAVITEV KDS POSTAJ v1.267.0')
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('POSODOBITEV (v1.267.0, PRIMERJAVA-VMESNIKOV-2026 \u00a741)')
  })

  test('Ž4: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.302.0-nadzorni-val-stabilnosti-iii')
  })
})
