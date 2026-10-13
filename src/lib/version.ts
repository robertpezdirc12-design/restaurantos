/**
 * Client-safe verzija aplikacije (OPS-2, v1.66.0).
 *
 * PREJ: APP_VERSION je živela v src/lib/api.ts (strežniški modul: db + auth
 * uvoz). `dashboard/page.tsx` ('use client') jo je uvažal od tam, kar je v
 * produkcijskem buildu v celoten client bundle vleklo verigo api.ts → auth.ts,
 * katerega module-scope fail-closed varovalka (APP_SECRET preverba, issue #4
 * §15) je v brskalniku (NODE_ENV=production, APP_SECRET ni v client envu)
 * CRASHALA dashboard za VSE uporabnike — error boundary "Ups — prišlo je do
 * napake" takoj po prijavi (OPS-1/OPS-2, produkcija @ c5f2190).
 *
 * Zdaj: čista konstanta BREZ uvozov — varna za client in server uvoz.
 * api.ts (server) jo pre-eksportira za nazajkompatibilnost strežniških rut;
 * client komponente MORAJO uvažati izključno iz '@/lib/version'.
 * Regresijsko varovano s tests/client-bundle-hygiene.test.ts (sk68-).
 */
export const APP_VERSION = '1.82.2'
export const APP_COMMIT = 'reconstruction-1.0.0'
