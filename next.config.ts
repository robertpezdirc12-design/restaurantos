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
