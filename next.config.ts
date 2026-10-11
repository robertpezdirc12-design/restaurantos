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
 * Frame zaščita (X-Frame-Options / CSP frame-ancestors) NAMENOMA NE še:
 * peskovni preview panel vgrajuje app v iframe in embed-origin ni verifikiran —
 * dodati šele s preverjenim seznamom dovoljenih origin-ov (audit §13 zapis).
 */
export const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true, // tsc je ločen gate v CI (tests job) — build hitrejši
  },
  reactStrictMode: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
