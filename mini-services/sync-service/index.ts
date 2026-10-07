/**
 * GitLab → GitHub samodejna sinhronizacija (push-trigger na gitlab.com se ne
 * sproži zanesljivo ob pushu — Sidekiq worker cadence).
 *
 * - vsakih SYNC_INTERVAL_MS: force-sync vseh push mirrorjev (POST remote_mirrors/:id/sync)
 * - GET  /sync    → takojšnja sinhronizacija (običajno po pushu)
 * - GET  /status  → zadnje stanje (per repo: ok/blocked + čas)
 * - GET  /health  → živost
 *
 * Port: 3032 (notranji; kliče se lokalno: curl http://127.0.0.1:3032/sync)
 */

const PORT = 3032
const SYNC_INTERVAL_MS = 5 * 60 * 1000

const GITLAB_TOKEN = process.env.GITLAB_SYNC_TOKEN || ""
const GITLAB_API = "https://gitlab.com/api/v4"

/** GitLab project ID → ime (GitHub repo je istega imena pri robertpezdirc12-design) */
const MIRRORS: Array<{ pid: number; name: string }> = [
  { pid: 87314868, name: "restaurantos" },
  { pid: 87315476, name: "discover-slovenia-ai" },
  { pid: 87314539, name: "roksal-railing-manager" },
  { pid: 87313405, name: "muzej-arhiv" },
  { pid: 87313303, name: "muzej" },
  { pid: 87312622, name: "markec-project" },
]

interface SyncResult {
  name: string
  ok: boolean
  detail: string
  at: string
}

let lastRun: { at: string; results: SyncResult[] } | null = null
let running = false

async function forceSync(pid: number): Promise<{ ok: boolean; detail: string }> {
  if (!GITLAB_TOKEN) return { ok: false, detail: "GITLAB_SYNC_TOKEN ni nastavljen" }
  try {
    const res = await fetch(`${GITLAB_API}/projects/${pid}/remote_mirrors`, {
      headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, "User-Agent": "git/2.43.0" },
    })
    if (!res.ok) return { ok: false, detail: `mirrors list HTTP ${res.status}` }
    const mirrors = (await res.json()) as Array<{ id: number; enabled: boolean }>
    const mirror = mirrors.find((m) => m.enabled)
    if (!mirror) return { ok: false, detail: "ni omogočenega mirrorja" }
    const sync = await fetch(`${GITLAB_API}/projects/${pid}/remote_mirrors/${mirror.id}/sync`, {
      method: "POST",
      headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, "User-Agent": "git/2.43.0" },
    })
    // GitLab vrne 200/201/202 ob sprejeti zahtevi; 409 "mirror is being updated" = že teče (ok)
    if (sync.ok || sync.status === 409) return { ok: true, detail: `sync HTTP ${sync.status}` }
    return { ok: false, detail: `sync HTTP ${sync.status}` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "napaka" }
  }
}

async function syncAll(trigger: string): Promise<{ at: string; results: SyncResult[] }> {
  if (running) return { at: new Date().toISOString(), results: [{ name: "*", ok: false, detail: "že teče", at: new Date().toISOString() }] }
  running = true
  const results: SyncResult[] = []
  for (const { pid, name } of MIRRORS) {
    const r = await forceSync(pid)
    results.push({ name, ...r, at: new Date().toISOString() })
    await new Promise((res) => setTimeout(res, 1500))
  }
  running = false
  const run = { at: new Date().toISOString(), results }
  lastRun = run
  console.log(`[${run.at}] sync (${trigger}): ${results.filter((r) => r.ok).length}/${results.length} ok — ${results.map((r) => `${r.name}:${r.ok ? "ok" : r.detail}`).join(", ")}`)
  return run
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/health") {
      return Response.json({ ok: true, mirrors: MIRRORS.length, intervalMs: SYNC_INTERVAL_MS, running, lastRun: lastRun?.at ?? null })
    }
    if (url.pathname === "/status") {
      return Response.json({ lastRun })
    }
    if (url.pathname === "/sync") {
      const run = await syncAll("manual")
      return Response.json(run)
    }
    return new Response("Not found", { status: 404 })
  },
})

console.log(`sync-service posluša na :${server.port} — interval ${SYNC_INTERVAL_MS / 1000}s, ${MIRRORS.length} mirrorjev, token ${GITLAB_TOKEN ? "nastavljen" : "MANJKA"}`)

// prvi tek ob zagonu + interval
await syncAll("startup")
setInterval(() => void syncAll("interval"), SYNC_INTERVAL_MS)
