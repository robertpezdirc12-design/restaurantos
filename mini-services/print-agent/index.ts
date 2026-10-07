/**
 * print-agent — ESC/POS network printer bridge for RestaurantOS (mini-service)
 *
 * The browser cannot open raw TCP sockets, so this local agent bridges:
 *   HTTP POST /print|/text  →  raw ESC/POS bytes  →  net.Socket TCP host:9100
 *
 * Endpoints (port hardcoded 3031 per spec, bind PRINT_AGENT_HOST, default 127.0.0.1):
 *   GET  /health → {ok:true, service:'print-agent', ts}
 *   POST /print  → {host, port?=9100, payloadBase64}            (raw bytes passthrough)
 *   POST /text   → {host, port?, text, align?, bold?, cut?=true} (builds ESC/POS, CP852)
 *   POST /layout → {host, port?, title?, lines:[{text,align?,bold?,size?}], cut?} (per-line styles)
 *
 * All printer-attempt outcomes respond 200 with ok:true|false (caller checks `ok`).
 * No external dependencies — Bun + node:net only.
 *
 * ---------------------------------------------------------------------------
 * Issue #4 §7 HARDENING (endpoint shapes unchanged — this is hardening only):
 *  - BIND:        PRINT_AGENT_HOST (default 127.0.0.1 — NOT 0.0.0.0 anymore).
 *  - AUTH:        PRINT_AGENT_TOKEN set → every POST requires header
 *                 `x-agent-token` (timing-safe compare). FAIL-CLOSED: binding a
 *                 non-loopback address WITHOUT a token refuses to start.
 *  - HOST allow:  PRINT_AGENT_ALLOWED_HOSTS (comma-separated exact names or
 *                 `*.suffix` wildcards). Default (env unset): ONLY private
 *                 ranges 10.0.0.0/8, 192.168.0.0/16, 172.16.0.0/12 and `*.local`
 *                 mDNS names. `localhost`/loopback is allowed ONLY when listed
 *                 explicitly. Public IPs are rejected. 169.254.0.0/16 (cloud
 *                 metadata) is ALWAYS rejected — even when explicitly allowlisted.
 *  - PORT allow:  PRINT_AGENT_ALLOWED_PORTS (default `9100,9101,9102`).
 *  - PAYLOAD:     decoded print payload max 64 KB → 413 {code:'payload_too_large'}.
 *  - HONESTY:     success means bytes were flushed to the kernel socket queue —
 *                 we cannot prove the printer physically printed → `note`.
 * Logs contain host:port, byte count and outcome only — NEVER payload content.
 * ---------------------------------------------------------------------------
 */
/// <reference types="bun-types" />

import net from "node:net";
import crypto from "node:crypto";

const PORT = 3031; // hardcoded per spec — do NOT read PORT env
const HOSTNAME = (process.env.PRINT_AGENT_HOST || "127.0.0.1").trim(); // default loopback (§7)
const CONNECT_TIMEOUT_MS = 4000; // 4s connect timeout
const IDLE_CLOSE_MS = 1500; // printers rarely close the socket → end after 1.5s idle
const HARD_CAP_MS = 8000; // absolute socket lifetime safety net
const MAX_PAYLOAD_BYTES = 64 * 1024; // §7: decoded payload hard limit (64 KB)

// --- §7 auth: optional shared token, timing-safe compared ------------------
const AGENT_TOKEN = process.env.PRINT_AGENT_TOKEN || "";

function isLoopbackBind(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.");
}

// Fail-closed LAN: a non-loopback bind without a token would expose an open
// TCP print relay to the whole network → refuse to start.
if (!isLoopbackBind(HOSTNAME) && !AGENT_TOKEN) {
  console.error(
    `[print-agent] FATAL: PRINT_AGENT_HOST=${HOSTNAME} is not loopback and PRINT_AGENT_TOKEN is not set.\n` +
      "[print-agent] Binding a network-reachable print bridge without auth is not allowed (fail-closed).\n" +
      "[print-agent] Set PRINT_AGENT_TOKEN=<secret> (clients send header x-agent-token) or bind 127.0.0.1.",
  );
  process.exit(1);
}

// --- §7 target host allowlist ----------------------------------------------
// Explicit allowlist (env): exact hostnames/IPs or `*.suffix` wildcard entries.
// Unset → default policy: private IPv4 ranges + `*.local` only; `localhost`,
// loopback and every other hostname are denied. Public IPs are denied under
// the default policy; an explicit entry is an informed operator override.
// 169.254.0.0/16 (cloud metadata) is ALWAYS denied regardless of config.
const ALLOWED_HOSTS = (process.env.PRINT_AGENT_ALLOWED_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase().replace(/\.$/, ""))
  .filter(Boolean);

const RE_IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isPrivateIPv4(h: string): boolean {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  return false;
}

function isLinkLocalIPv4(h: string): boolean {
  return h.startsWith("169.254."); // 169.254.0.0/16 — cloud metadata / link-local
}

function explicitHostMatch(h: string): boolean {
  for (const entry of ALLOWED_HOSTS) {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".local"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

/** §7: validate/normalize the requested print target host. Returns null when denied. */
function normalizeAllowedHost(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!h || h.includes("/")) return null; // empty or CIDR-ish input → deny
  // cloud metadata / link-local — non-negotiable
  if (isLinkLocalIPv4(h)) return null;
  if (h === "169.254.169.254") return null;

  if (RE_IPV4.test(h)) {
    if (isPrivateIPv4(h)) return h; // LAN printer — default policy OK
    return explicitHostMatch(h) ? h : null; // public/loopback IPv4 → explicit only
  }
  if (h === "localhost" || h.startsWith("127.") || h === "::1") {
    return explicitHostMatch(h) ? h : null; // loopback target is a rarity → explicit only
  }
  if (h.includes(":")) return explicitHostMatch(h) ? h : null; // IPv6 → explicit only
  if (h.endsWith(".local")) return h; // mDNS printer — default policy OK
  return explicitHostMatch(h) ? h : null; // other hostnames → explicit only
}

// --- §7 target port allowlist -----------------------------------------------
const DEFAULT_PORTS = "9100,9101,9102";
const ALLOWED_PORTS: ReadonlySet<number> = new Set(
  (process.env.PRINT_AGENT_ALLOWED_PORTS || DEFAULT_PORTS)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535),
);

// ---------------------------------------------------------------------------
// CP852 (Latin-2) — Slovenian characters MUST be encoded in CP852, not utf8.
// Bun Buffer does not support cp852 natively → embedded byte table.
//
// Generated on this machine with:
//   python3 -c "import sys; [print(ch, hex(ord(ch)), ch.encode('cp852').hex()) for ch in 'čšžČŠŽđĐćĆ']"
// ---------------------------------------------------------------------------
const CP852_SLO: Record<string, number> = {
  č: 0x9f, // č U+010D → 9f
  š: 0xe7, // š U+0161 → e7
  ž: 0xa7, // ž U+017E → a7
  Č: 0xac, // Č U+010C → ac
  Š: 0xe6, // Š U+0160 → e6
  Ž: 0xa6, // Ž U+017D → a6
  đ: 0xd0, // đ U+0111 → d0
  Đ: 0xd1, // Đ U+0110 → d1
  ć: 0x86, // ć U+0107 → 86
  Ć: 0x8f, // Ć U+0106 → 8f
};

// Full printable CP852 reverse table (byte 0x20..0xFF → unicode char), generated with:
//   python3 -c "import json
//     for b in range(0x20, 0x100):
//       ch = bytes([b]).decode('cp852')
//       if ord(ch) < 0x80 or not (ch.isprintable() or ch == '\xa0'): continue
//       print('  %s: 0x%02X,' % (json.dumps(ch), b))"
// (\uXXXX escapes are valid JS string syntax — verbatim python output.)
const CP852_FULL: Record<string, number> = {
  "\u00c7": 0x80,
  "\u00fc": 0x81,
  "\u00e9": 0x82,
  "\u00e2": 0x83,
  "\u00e4": 0x84,
  "\u016f": 0x85,
  "\u0107": 0x86,
  "\u00e7": 0x87,
  "\u0142": 0x88,
  "\u00eb": 0x89,
  "\u0150": 0x8a,
  "\u0151": 0x8b,
  "\u00ee": 0x8c,
  "\u0179": 0x8d,
  "\u00c4": 0x8e,
  "\u0106": 0x8f,
  "\u00c9": 0x90,
  "\u0139": 0x91,
  "\u013a": 0x92,
  "\u00f4": 0x93,
  "\u00f6": 0x94,
  "\u013d": 0x95,
  "\u013e": 0x96,
  "\u015a": 0x97,
  "\u015b": 0x98,
  "\u00d6": 0x99,
  "\u00dc": 0x9a,
  "\u0164": 0x9b,
  "\u0165": 0x9c,
  "\u0141": 0x9d,
  "\u00d7": 0x9e,
  "\u010d": 0x9f,
  "\u00e1": 0xa0,
  "\u00ed": 0xa1,
  "\u00f3": 0xa2,
  "\u00fa": 0xa3,
  "\u0104": 0xa4,
  "\u0105": 0xa5,
  "\u017d": 0xa6,
  "\u017e": 0xa7,
  "\u0118": 0xa8,
  "\u0119": 0xa9,
  "\u00ac": 0xaa,
  "\u017a": 0xab,
  "\u010c": 0xac,
  "\u015f": 0xad,
  "\u00ab": 0xae,
  "\u00bb": 0xaf,
  "\u2591": 0xb0,
  "\u2592": 0xb1,
  "\u2593": 0xb2,
  "\u2502": 0xb3,
  "\u2524": 0xb4,
  "\u00c1": 0xb5,
  "\u00c2": 0xb6,
  "\u011a": 0xb7,
  "\u015e": 0xb8,
  "\u2563": 0xb9,
  "\u2551": 0xba,
  "\u2557": 0xbb,
  "\u255d": 0xbc,
  "\u017b": 0xbd,
  "\u017c": 0xbe,
  "\u2510": 0xbf,
  "\u2514": 0xc0,
  "\u2534": 0xc1,
  "\u252c": 0xc2,
  "\u251c": 0xc3,
  "\u2500": 0xc4,
  "\u253c": 0xc5,
  "\u0102": 0xc6,
  "\u0103": 0xc7,
  "\u255a": 0xc8,
  "\u2554": 0xc9,
  "\u2569": 0xca,
  "\u2566": 0xcb,
  "\u2560": 0xcc,
  "\u2550": 0xcd,
  "\u256c": 0xce,
  "\u00a4": 0xcf,
  "\u0111": 0xd0,
  "\u0110": 0xd1,
  "\u010e": 0xd2,
  "\u00cb": 0xd3,
  "\u010f": 0xd4,
  "\u0147": 0xd5,
  "\u00cd": 0xd6,
  "\u00ce": 0xd7,
  "\u011b": 0xd8,
  "\u2518": 0xd9,
  "\u250c": 0xda,
  "\u2588": 0xdb,
  "\u2584": 0xdc,
  "\u0162": 0xdd,
  "\u016e": 0xde,
  "\u2580": 0xdf,
  "\u00d3": 0xe0,
  "\u00df": 0xe1,
  "\u00d4": 0xe2,
  "\u0143": 0xe3,
  "\u0144": 0xe4,
  "\u0148": 0xe5,
  "\u0160": 0xe6,
  "\u0161": 0xe7,
  "\u0154": 0xe8,
  "\u00da": 0xe9,
  "\u0155": 0xea,
  "\u0170": 0xeb,
  "\u00fd": 0xec,
  "\u00dd": 0xed,
  "\u0163": 0xee,
  "\u00b4": 0xef,
  "\u02dd": 0xf1,
  "\u02db": 0xf2,
  "\u02c7": 0xf3,
  "\u02d8": 0xf4,
  "\u00a7": 0xf5,
  "\u00f7": 0xf6,
  "\u00b8": 0xf7,
  "\u00b0": 0xf8,
  "\u00a8": 0xf9,
  "\u02d9": 0xfa,
  "\u0171": 0xfb,
  "\u0158": 0xfc,
  "\u0159": 0xfd,
  "\u25a0": 0xfe,
  "\u00a0": 0xff,
};

/** Encode text → CP852 bytes. Slovenian chars via table, ASCII passthrough, unmappable → '?' (0x3F). '\n' → 0x0A. */
function encodeCp852(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    if (ch === "\n") {
      out.push(0x0a); // line feed per line
      continue;
    }
    const mapped = CP852_SLO[ch] ?? CP852_FULL[ch];
    if (mapped !== undefined) {
      out.push(mapped);
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0x3f;
    out.push(cp < 0x80 ? cp : 0x3f); // unmappable → '?'
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// ESC/POS payload builder
// ---------------------------------------------------------------------------
const ESC = [0x1b, 0x40]; // ESC @        — initialize printer
const CODEPAGE_CP852 = [0x1b, 0x74, 0x12]; // ESC t 18  — Epson codepage 18 = CP852
const ALIGN = { left: 0x00, center: 0x01, right: 0x02 } as const;

interface TextJob {
  text: string;
  align?: "left" | "center" | "right";
  bold?: boolean;
  cut?: boolean;
}

interface LayoutLine {
  text: string;
  align?: "left" | "center" | "right";
  bold?: boolean;
  size?: "normal" | "large";
}

/** Večvrstični dokument s per-line stili (title je prva centrirana veljavrstica) */
function buildEscPosLines(title: string, lines: LayoutLine[], cut = true): Uint8Array {
  const out: number[] = [];
  const push = (...bytes: number[]) => out.push(...bytes);
  push(...ESC);
  push(...CODEPAGE_CP852);

  const emitLine = (line: LayoutLine) => {
    const align = line.align && line.align in ALIGN ? line.align : "left";
    push(0x1b, 0x61, ALIGN[align]);
    if (line.bold) push(0x1b, 0x45, 0x01);
    if (line.size === "large") push(0x1d, 0x21, 0x11);
    const normalized = line.text.endsWith("\n") ? line.text : `${line.text}\n`;
    for (const b of encodeCp852(normalized)) out.push(b);
    if (line.size === "large") push(0x1d, 0x21, 0x00);
    if (line.bold) push(0x1b, 0x45, 0x00);
  };

  if (title) emitLine({ text: title, align: "center", bold: true, size: "large" });
  for (const raw of lines) {
    // explicit merge (not a bare spread) — TS2783 + runtime-safe defaults
    const line: LayoutLine = {
      text: typeof raw?.text === "string" ? raw.text : "",
      align: raw?.align,
      bold: raw?.bold,
      size: raw?.size,
    };
    emitLine(line);
  }
  if (cut) push(0x1d, 0x56, 0x42, 0x00);
  return Uint8Array.from(out);
}

function buildEscPosText(job: TextJob): Uint8Array {
  const align = job.align && job.align in ALIGN ? job.align : "left";
  const bold = job.bold === true;
  const cut = job.cut !== false; // default true

  const out: number[] = [];
  const push = (...bytes: number[]) => out.push(...bytes);

  push(...ESC); // 1B 40
  push(...CODEPAGE_CP852); // 1B 74 12
  push(0x1b, 0x61, ALIGN[align]); // 1B 61 00|01|02
  if (bold) {
    push(0x1b, 0x45, 0x01); // ESC E 1  — bold on
    push(0x1d, 0x21, 0x11); // GS ! 11  — double width+height (header emphasis)
  }
  // Lines separated by \n → append 0x0A per line (every line LF-terminated;
  // a trailing \n in the input is not doubled).
  const normalized = job.text.endsWith("\n") ? job.text : `${job.text}\n`;
  const encoded = encodeCp852(normalized);
  for (const b of encoded) out.push(b);
  if (bold) {
    push(0x1b, 0x45, 0x00); // ESC E 0  — bold off
    push(0x1d, 0x21, 0x00); // GS ! 00  — size back to normal
  }
  if (cut) push(0x1d, 0x56, 0x42, 0x00); // GS V B 0 — partial cut
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Raw TCP sender (net.Socket with 4s connect timeout, graceful drain/close)
// ---------------------------------------------------------------------------
class PrintError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "PrintError";
    this.code = code;
  }
}

function readableError(code: string | undefined, host: string, port: number, raw: string): string {
  const target = `${host}:${port}`;
  switch (code) {
    case "ECONNREFUSED":
      return `connection refused by ${target} (nothing listening — printer off/unreachable?)`;
    case "ETIMEDOUT":
      return `timed out connecting to ${target}`;
    case "ENOTFOUND":
      return `host ${host} not found`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `network unreachable for ${target}`;
    case "ECONNRESET":
      return `connection reset by ${target}`;
    case "EPIPE":
      return `broken pipe to ${target}`;
    default:
      return raw || code || `unknown socket error for ${target}`;
  }
}

/** Open TCP socket, write all bytes, wait for drain → printer close or 1.5s idle → graceful end. */
function sendRaw(host: string, port: number, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    let wrote = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let capTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (err?: PrintError) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(idleTimer);
      clearTimeout(capTimer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    // 4s connect timeout (spec)
    connectTimer = setTimeout(() => {
      finish(new PrintError(`timed out connecting to ${host}:${port} after ${CONNECT_TIMEOUT_MS}ms`, "ETIMEDOUT"));
    }, CONNECT_TIMEOUT_MS);

    // absolute lifetime cap so a chatty printer can never hang a job
    capTimer = setTimeout(() => {
      finish(
        wrote
          ? undefined // bytes already handed to the kernel — count as delivered
          : new PrintError(`socket to ${host}:${port} did not complete in ${HARD_CAP_MS}ms`, "ETIMEDOUT"),
      );
    }, HARD_CAP_MS);

    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (wrote) {
        finish(); // bytes already flushed to kernel — delivery done, late errors irrelevant
        return;
      }
      finish(new PrintError(readableError(err.code, host, port, err.message), err.code ?? "ESOCKET"));
    });

    // graceful end: printers rarely close → after write drains, end after 1.5s idle
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          socket.end(); // send FIN, keep flushing
        } catch {
          /* already dead */
        }
        setTimeout(() => finish(), 400); // fallback if 'close' never fires
      }, IDLE_CLOSE_MS);
    };

    socket.on("connect", () => {
      clearTimeout(connectTimer);
      socket.write(bytes, () => {
        wrote = true;
        armIdle();
      });
    });

    socket.on("data", () => armIdle()); // printer status chatter resets idle timer

    socket.on("close", () => {
      if (wrote) finish(); // normal completion path
      // if !wrote the 'error' event fires first (ECONNREFUSED etc.) — do nothing here
    });

    socket.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
let jobCounter = 0;

function logJob(route: string, target: string, bytes: number, ms: number, ok: boolean, code?: string) {
  const n = ++jobCounter;
  const status = ok ? "OK" : `FAIL ${code ?? ""}`.trim();
  console.log(`[job ${n}] ${route} → ${target} ${bytes}B ${status} (${ms.toFixed(0)}ms)`);
}

/** §7: security rejections are logged too (metadata only — never payload, never token). */
function logReject(route: string, target: string, reason: string) {
  const n = ++jobCounter;
  console.log(`[job ${n}] ${route} → ${target} REJECTED (${reason})`);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** §7: timing-safe token check — hashes both sides to a fixed length first. */
function tokenOk(req: Request): boolean {
  if (!AGENT_TOKEN) return true; // no token configured → loopback-only bind (enforced at boot)
  const provided = req.headers.get("x-agent-token") || "";
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(AGENT_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // GET /health
  if (req.method === "GET" && path === "/health") {
    return json({ ok: true, service: "print-agent", ts: Date.now() });
  }

  // POST /print | POST /text | POST /layout
  if (req.method === "POST" && (path === "/print" || path === "/text" || path === "/layout")) {
    // §7 auth: token required whenever PRINT_AGENT_TOKEN is configured
    if (!tokenOk(req)) {
      logReject(path, "unauthenticated", "missing/invalid x-agent-token");
      return json({ ok: false, error: "unauthorized — missing or invalid x-agent-token header", code: "unauthorized" }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "invalid json" }, 400);
    }

    const rawHost = typeof body.host === "string" ? body.host.trim() : "";
    if (!rawHost) return json({ ok: false, error: "missing host" }, 400);

    // §7 host allowlist (default: private LAN ranges + *.local; metadata always denied)
    const host = normalizeAllowedHost(rawHost);
    if (!host) {
      logReject(path, `${rawHost}:?`, "host not allowed (allowlist)");
      return json({ ok: false, error: "host not allowed by print-agent allowlist", code: "host_not_allowed" }, 403);
    }

    let port = 9100;
    if (body.port !== undefined) {
      const p = Number(body.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return json({ ok: false, error: "invalid port" }, 400);
      port = p;
    }
    // §7 port allowlist (default 9100,9101,9102)
    if (!ALLOWED_PORTS.has(port)) {
      logReject(path, `${host}:${port}`, "port not allowed (allowlist)");
      return json({ ok: false, error: "port not allowed by print-agent allowlist", code: "port_not_allowed" }, 403);
    }

    let bytes: Uint8Array;
    if (path === "/print") {
      const payloadBase64 = typeof body.payloadBase64 === "string" ? body.payloadBase64 : "";
      if (!payloadBase64) return json({ ok: false, error: "missing payloadBase64" }, 400);
      bytes = new Uint8Array(Buffer.from(payloadBase64, "base64"));
      if (bytes.length === 0) return json({ ok: false, error: "payloadBase64 decodes to 0 bytes" }, 400);
    } else if (path === "/layout") {
      const lines = Array.isArray(body.lines) ? (body.lines as LayoutLine[]) : [];
      if (lines.length === 0) return json({ ok: false, error: "missing lines" }, 400);
      bytes = buildEscPosLines(
        typeof body.title === "string" ? body.title : "",
        lines,
        body.cut !== false
      );
    } else {
      const text = typeof body.text === "string" ? body.text : "";
      if (!text) return json({ ok: false, error: "missing text" }, 400);
      bytes = buildEscPosText({
        text,
        align: body.align as TextJob["align"] | undefined,
        bold: body.bold === true,
        cut: body.cut !== false,
      });
    }

    // §7 payload size limit — 64 KB decoded, applies to all print endpoints
    if (bytes.length > MAX_PAYLOAD_BYTES) {
      logReject(path, `${host}:${port}`, `payload too large (${bytes.length}B > ${MAX_PAYLOAD_BYTES}B)`);
      return json({ ok: false, error: `payload exceeds ${MAX_PAYLOAD_BYTES} byte limit`, code: "payload_too_large" }, 413);
    }

    const t0 = performance.now();
    try {
      await sendRaw(host, port, bytes);
      logJob(path, `${host}:${port}`, bytes.length, performance.now() - t0, true);
      // honest reporting: bytes are handed to the kernel socket — we CANNOT prove
      // the printer physically printed (no out-of-band confirmation exists)
      return json({ ok: true, bytes: bytes.length, host, port, note: "delivered-to-kernel" });
    } catch (err) {
      const e = err instanceof PrintError ? err : new PrintError(String(err), "ESOCKET");
      logJob(path, `${host}:${port}`, bytes.length, performance.now() - t0, false, e.code);
      return json({ ok: false, error: e.message, code: e.code }, 200); // ok:false = failure, never 5xx
    }
  }

  return json({ ok: false, error: "not found" }, 404);
}

console.log(`[print-agent] ESC/POS bridge starting on http://${HOSTNAME}:${PORT}`);
console.log("[print-agent] cp852 table ready:", Object.keys(CP852_SLO).join(" "), `(+${Object.keys(CP852_FULL).length} full-table entries)`);
console.log(
  `[print-agent] config: auth=${AGENT_TOKEN ? "token required (x-agent-token)" : "OFF (loopback bind only)"} · ` +
    `host allowlist=${ALLOWED_HOSTS.length ? `explicit [${ALLOWED_HOSTS.length} entries]` : "default (private ranges + *.local; 169.254/16 always denied)"} · ` +
    `ports=[${[...ALLOWED_PORTS].join(",")}] · payload≤${MAX_PAYLOAD_BYTES}B`,
);

Bun.serve({ hostname: HOSTNAME, port: PORT, fetch: handle });
console.log(`[print-agent] listening on http://${HOSTNAME}:${PORT}`);
