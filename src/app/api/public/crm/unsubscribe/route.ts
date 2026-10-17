import { NextRequest, NextResponse } from 'next/server'
import { rateLimitPublic, clientIp } from '@/lib/guest'
import { unsubscribeByToken } from '@/lib/crm'

/**
 * Issue #11 §1/§3 — JAVNA enklik odjava iz marketinga (povezava v nogi vsake
 * pošiljke: /api/public/crm/unsubscribe?token=<32-hex>&lang=sl|hr|en).
 *
 * GET = enklik (en klik, brez dodatnega potrdila — GDPR: preklic je tako
 * preprosten kot dodelitev) + prijazna HTML stran. POST sprejme isti token
 * (za javascript pot). OBA poti idempotentna (ponovni klik = "že odjavljeni").
 *
 * Varnost: rate-limit 10/min/IP; neveljaven žeton → splošno sporočilo
 * (BREZ razkritja, ali žeton obstaja); odjava je KANALNO specifična
 * (email pošiljka odjavi email, SMS SMS — stanja se NE predpostavita).
 * Žeton NE izda podatka o gostu (naslov/ime) — samo potrditev odjave.
 */
function page(kind: 'ok' | 'already' | 'invalid', lang: string): NextResponse {
  const l = ['sl', 'hr', 'en'].includes(lang) ? lang : 'sl'
  const texts: Record<string, Record<string, [string, string]>> = {
    ok: {
      sl: ['Odjava uspešna', 'Naslovnik je bil odjavljen iz marketing sporočil te lokacije. Žal vam je žal — hvala, da ste bili z nami.'],
      hr: ['Odjava uspješna', 'Primatelj je odjavljen iz marketing poruka ove lokacije. Žao nam je — hvala što ste bili s nama.'],
      en: ['Unsubscribed', 'The recipient has been unsubscribed from marketing messages of this location. Sorry to see you go — thank you for being with us.'],
    },
    already: {
      sl: ['Že odjavljeni', 'Ta povezava je že uporabljena — naslovnik JE odjavljen. Nadaljnja sporočila ne bodo poslana.'],
      hr: ['Već odjavljeni', 'Ova je povezava već iskorištena — primatelj JE odjavljen. Daljnje poruke neće biti poslane.'],
      en: ['Already unsubscribed', 'This link has already been used — the recipient IS unsubscribed. No further messages will be sent.'],
    },
    invalid: {
      sl: ['Neveljavna povezava', 'Ta povezava za odjavo ni veljavna ali je potekla. Če želite odjavo, stopite v stik z lokacijo.'],
      hr: ['Nevaljana poveznica', 'Ova poveznica za odjavu nije valjana ili je istekla. Ako želite odjavu, obratite se lokaciji.'],
      en: ['Invalid link', 'This unsubscribe link is not valid or has expired. If you wish to unsubscribe, please contact the location.'],
    },
  }
  const [title, body] = texts[kind][l]
  const html = `<!doctype html>
<html lang="${l}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #fafaf9; color: #292524;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; padding: 1rem; }
  .card { background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 2rem;
          max-width: 28rem; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  p { font-size: .95rem; line-height: 1.5; color: #57534e; margin: 0; }
  .badge { width: 3rem; height: 3rem; margin: 0 auto 1rem; border-radius: 9999px;
           display: flex; align-items: center; justify-content: center; font-size: 1.5rem;
           background: ${kind === 'invalid' ? '#fef2f2' : '#f0fdf4'}; }
</style>
</head>
<body>
  <main class="card" role="main">
    <div class="badge" aria-hidden="true">${kind === 'invalid' ? '✕' : '✓'}</div>
    <h1>${title}</h1>
    <p>${body}</p>
  </main>
</body>
</html>`
  return new NextResponse(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function handle(req: NextRequest, token: string, lang: string): Promise<NextResponse> {
  // rate-limit (10/min/IP — javna ruta, dokumentirana meja)
  if (!(await rateLimitPublic(`crm-unsub:${clientIp(req)}`, 10))) {
    return new NextResponse('Too many requests', { status: 429 })
  }
  const outcome = await unsubscribeByToken(token)
  if (outcome.kind === 'invalid') return page('invalid', lang)
  return page(outcome.kind === 'ok' ? 'ok' : 'already', lang)
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  return handle(req, url.searchParams.get('token') ?? '', url.searchParams.get('lang') ?? 'sl')
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { token?: string; lang?: string } | null
  return handle(req, String(body?.token ?? ''), String(body?.lang ?? 'sl'))
}
