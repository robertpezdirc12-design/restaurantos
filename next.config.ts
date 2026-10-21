import type { NextConfig } from "next";

/**
 * Varnostne glave (Task 49) — osnovni nivo brez UI vpliva, veljavno za VSE rute:
 *  - HSTS: produkcija (Vercel) je HTTPS-only; brskalnik po prvem obisku vsili HTTPS
 *    (na localhost/HTTP brskalniki glavo ignorirajo — varno tudi v peskovniku).
 *  - nosniff: prepreči MIME-sniffing (npr. uploade kot izvedljive).
 *  - Referrer-Policy: minimalen prenos podatkov preko refererja.
 *  - Permissions-Policy: kamera/mikrofon/geolokacija zavrnjeni — koda jih ne
 *    uporablja (preverjeno Task 49: noben getUserMedia/geolocation klic).
 *    Ob prihodnjem QR-skanerju kamera= ponovno dovoliti ciljano.
 *
 * Frame zaščita (issue #2 §D, v1.87.1) — DOLOČENA politika vdelovanja:
 *  - CSP frame-ancestors 'self': vgradnja SAMO iz istega izvora (gateway/peskovni
 *    preview streže app prek istega izvora → predogled OHRANJEN; tuje strani ne
 *    morejo iframe-ati POS). Edini iframe v kodi = predogled PRILOGE stroškov
 *    (finance-tab, isti origin) → dovoljen.
 *  - X-Frame-Options: SAMEORIGIN — usklajen s frame-ancestors (isti pomen, brez
 *    konflikta; podpora starejšim brskalnikom). CSP default-src/script-src je
 *    NAMENOMA izven te glave (nonce/hash režim + Stripe = ločena naloga).
 */
export const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
];

const nextConfig: NextConfig = {
  /**
   * v1.165.0 — lokalni profil streže `next start`; standalone output bi zahteval
   * ročno kopiranje `.next/static` in `public` v samostojno mapo. Vercel (brez
   * RESTAURANTOS_LOCAL) ostaja standalone, zato se oblačni build ne spremeni.
   */
  ...(process.env.RESTAURANTOS_LOCAL === "1" ? {} : { output: "standalone" as const }),
  /**
   * Audit okt-2026 #18: prej je bil tukaj `typescript: { ignoreBuildErrors: true }`
   * s komentarjem „tsc je ločen gate v CI". Drži samo delno: `tests` in
   * `typecheck-prod` res tečeta, a Vercel Git integration zgradi in deploya ob
   * pushu — vzporedno s CI-jem in brez odvisnosti od njega. Zapora torej ni
   * blokirala ničesar: napaka tipov je bila v produkciji, CI jo je potrkal šele
   * potem, ko je že živela.
   *
   * `next build` zdaj tipizira (privzeto, brez izjeme). tsconfig izrecno izpušča
   * `tests/`, zato testne datoteke ne morejo blokirati deploya; pod Verclovim
   * Postgres klientom je to isti proračun, kot ga `typecheck-prod` in je zelen.
   *
   * Nastavitve ne vnašaj nazaj kot „hitrejši build": build je na uro največ eden,
   * tipiziranje pa edina zapora, ki dejansko stoji pred produkcijo.
   */
  reactStrictMode: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
