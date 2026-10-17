/**
 * APP_VERSION — enkratna resnica o verziji aplikacije.
 * Stranke: footer, /api/health, ukazna paleta, PWA register.
 *
 * PREJ: APP_VERSION je živela v src/lib/api.ts (strežniški modul: db + auth
 * importi) — client komponente, ki so jo uvažale, so skupaj s sabo vlekle
 * cel server dependency graf v client bundle (~90 kB gz). Po poteh issue #70
 * je bila izkušnja ista: izvoz iz server-only modula = hydratcijska veriga
 * server odvisnosti v clientu.
 *
 * ODLOČITEV (v1.124.0, sk16): verzija živi TUKAJ, v modulu brez
 * strežniških stranskih uvozov; api.ts jo le re-izvaža izključno za
 * strežniške potrošnike.
 * client komponente MORAJO uvažati izključno iz '@/lib/version'.
 * Regresijsko varovano s tests/client-bundle-hygiene.test.ts (sk68-).
 */
export const APP_VERSION = '1.132.0'
export const APP_COMMIT = 'reconstruction-1.0.0'
