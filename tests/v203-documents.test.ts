/**
 * OSS-2 (v1.203.0) — DOKUMENTI S PRIPONKAMI
 * (docs/GAP-ANALIZA-odprtokodna-konkurenca.md — kandidat OSS-2, izvor OrderRestro #17).
 *
 * Merila:
 *  Č1 čisti sloj documents.ts (PURE, 0 DB): parseDocumentInput (naziv 1–120
 *     obvezen; kategorija iz znane množice sop/pogodba/receptura/navodilo/
 *     ostalo z privzetkom sop; opis ≤ 500; fileName sanitizacija — brez poti/
 *     kontrolnih/narekovajev, ≤ 200; mime allowlist BREZ SVG/HTML; base64
 *     validacija + velikost iz dolžine; budget 1 MB raw; data: URL strip),
 *     parseDocumentPatch (meta samostojna; zamenjava vsebine = CEL paket
 *     fileName+mimeType+contentBase64, delni paket = napaka; brez sprememb =
 *     napaka), documentDto (content NIKOLI v DTO), humanSize,
 *     contentDispositionValue (ASCII fallback + UTF-8*), isAllowedMime,
 *     isValidBase64, base64SizeBytes, stripBase64DataUrl, safeFileName.
 *  Č2 backend:
 *     - 401 brez žetona (GET/POST/PATCH/DELETE/download);
 *     - 503 do DDL (probe false — eksplicitna, vse rute; test hook);
 *     - POST ustvari dokument (201, verzija 1, vsebina v bazi) + audit
 *       DOCUMENT_CREATE; DTO brez vsebine; data: URL sprejet; SVG → 400;
 *       prevelik → 400; waiter brez settings.manage → 403;
 *     - GET obseg: manager izključno svoja lokacija (fail-closed), admin
 *       centralno org obseg + lokacije, waiter (vse vloge branje) vidi svojo;
 *       ?category filter;
 *     - PATCH metapodatki (verzija OSTANE) / cel paket (verzija +1, ime/vrsta/
 *       velikost) + audit DOCUMENT_UPDATED; brez sprememb → 400; delni paket → 400;
 *     - download: Content-Disposition attachment + nosniff + private no-store,
 *       byte-točna vsebina (round-trip); tuja lokacija → 403 (guardResource);
 *     - DELETE + audit DOCUMENT_DELETED; 404 neznani id.
 *  Č3 DDL ruta /api/admin/migrate-documents: 403 za managerja
 *     (requireCentralRole), 200 za admina (na SQLite tabela že prek db push →
 *     skipped; audit SCHEMA_MIGRATION_DOCUMENTS).
 *  Č4 UI statika + registri: kartica documents-card (klici + t() ključi),
 *     i18n pariteta novih ključev (SL/HR), model v OBEH shemah, baseline
 *     migracija, SCHEMA_MIGRATIONS 36 + register, drift allowlist 28
 *     (classifyDrift prepozna CREATE TABLE "Document"), verzija pin.
 *
 * Fiksture s predpono v203doc-; tekočo ustvarjene/izbrisane — po teku testa je
 * tabela Document v vhodnem stanju (COUNT fikstur = 0).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import {
  ALLOWED_MIME_TYPES,
  DEFAULT_DOCUMENT_CATEGORY,
  MAX_DOCUMENT_BYTES,
  base64SizeBytes,
  contentDispositionValue,
  documentDto,
  humanSize,
  isAllowedMime,
  isValidBase64,
  parseDocumentInput,
  parseDocumentPatch,
  safeFileName,
  stripBase64DataUrl,
} from '../src/lib/documents'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import {
  __setDocumentsTableReadyForTests,
  __resetDocumentsTableReadyForTests,
} from '../src/lib/documents-store'
import { classifyDrift, KNOWN_DRIFTS } from '../scripts/drift-check'
import { GET as documentsGET, POST as documentsPOST } from '../src/app/api/documents/route'
import { PATCH as documentsPATCH, DELETE as documentsDELETE } from '../src/app/api/documents/[id]/route'
import { GET as downloadGET } from '../src/app/api/documents/[id]/download/route'
import { POST as migratePOST } from '../src/app/api/admin/migrate-documents/route'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v203doc-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const TZ = 'Europe/Ljubljana'

/** deterministična vsebina: mala PDF-head datoteka → base64 (izračunano, ne ročno) */
const PDF_CONTENT = Buffer.from('%PDF-1.4 testni dokument v203').toString('base64')
const PDF_BYTES = Buffer.from('%PDF-1.4 testni dokument v203').byteLength
const PNG_CONTENT = Buffer.from('PNG-podatki za zamenjavo v203').toString('base64')
const PNG_BYTES = Buffer.from('PNG-podatki za zamenjavo v203').byteLength

let locA = ''
let locB = ''
let mgr = ''
let waiter = ''
let admin = ''
let tok = ''
let waiterToken = ''
let adminToken = ''

function req(method: string, url: string, token: string | null, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

async function cleanup() {
  await db.document
    .deleteMany({
      where: { OR: [{ locationId: { startsWith: P } }, { id: { startsWith: P } }, { createdById: { startsWith: P } }] },
    })
    .catch(() => null)
  await db.auditLog
    .deleteMany({
      where: {
        OR: [
          { locationId: { startsWith: P } },
          { entityId: { startsWith: P } },
          {
            action: {
              in: [
                'DOCUMENT_CREATE',
                'DOCUMENT_UPDATED',
                'DOCUMENT_DELETED',
                'SCHEMA_MIGRATION_DOCUMENTS',
              ],
            },
          },
        ],
      },
    })
    .catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  __setDocumentsTableReadyForTests(true) // tabela je prek db push prisotna v dev/CI bazi
  await cleanup()

  const la = await db.location.create({
    data: { id: `${P}locA-${RUN}`, name: `${P}Ljubljana`, code: `W23A-${RUN.toUpperCase()}`, timezone: TZ, country: 'SI' },
  })
  locA = la.id
  const lb = await db.location.create({
    data: { id: `${P}locB-${RUN}`, name: `${P}Maribor`, code: `W23B-${RUN.toUpperCase()}`, timezone: TZ, country: 'SI' },
  })
  locB = lb.id

  const seed = async (key: string, name: string, role: string, seq: number): Promise<string> => {
    const id = `${P}${key}-${RUN}`
    const f = employeePinFields(`${PIN_BASE}${seq}`, `${id}@test.local`)
    await db.employee.create({
      data: { id, name, email: `${id}@test.local`, role, status: 'active', sessionVersion: 0, locationId: locA, pin: f.pin, pinLookup: f.pinLookup },
    })
    return id
  }
  mgr = await seed('mgr', `${P}Vodja Vida`, 'manager', 1)
  waiter = await seed('waiter', `${P}Natakar Nace`, 'waiter', 2)
  admin = await seed('admin', `${P}Admin Alja`, 'admin', 3)
  // Issue #72 C1: settings.manage je central grant — manager ga NIMA v privzetkih.
  await db.employee.update({ where: { id: mgr }, data: { permissionOverrides: JSON.stringify(['settings.manage']) } })
  tok = createToken({ sub: mgr, name: `${P}Vodja Vida`, role: 'MANAGER', loc: locA, sv: 0 })
  waiterToken = createToken({ sub: waiter, name: `${P}Natakar Nace`, role: 'WAITER', loc: locA, sv: 0 })
  adminToken = createToken({ sub: admin, name: `${P}Admin Alja`, role: 'ADMIN', loc: locA, sv: 0 })
})

afterAll(async () => {
  __resetDocumentsTableReadyForTests() // probe nazaj na dev resnico (ponovna preiskava)
  await cleanup()
})

/* ═══════════════════ Č1. ČISTI SLOJ (documents.ts) ═══════════════════ */

describe('Č1 čisti sloj dokumentov (pure)', () => {
  it('isAllowedMime: PDF/slike/besedilo/CSV/Office dovoljeni; SVG/HTML/neznan NISO', () => {
    expect(ALLOWED_MIME_TYPES).toHaveLength(9)
    expect(isAllowedMime('application/pdf')).toBe(true)
    expect(isAllowedMime('image/png')).toBe(true)
    expect(isAllowedMime('image/jpeg')).toBe(true)
    expect(isAllowedMime('image/webp')).toBe(true)
    expect(isAllowedMime('text/plain')).toBe(true)
    expect(isAllowedMime('text/csv')).toBe(true)
    expect(isAllowedMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true)
    // inline-izvedba tveganja NISO na listi (deterministično)
    expect(isAllowedMime('image/svg+xml')).toBe(false)
    expect(isAllowedMime('text/html')).toBe(false)
    expect(isAllowedMime('application/javascript')).toBe(false)
    expect(isAllowedMime('image/')).toBe(false)
    expect(isAllowedMime(undefined)).toBe(false)
    expect(isAllowedMime(42)).toBe(false)
    expect(DEFAULT_DOCUMENT_CATEGORY).toBe('sop')
  })

  it('isValidBase64 + base64SizeBytes: dolžina % 4, padding ocena raw bajtov', () => {
    expect(isValidBase64(PDF_CONTENT)).toBe(true)
    expect(isValidBase64('AAAA')).toBe(true)
    expect(isValidBase64('AAA=')).toBe(true)
    expect(isValidBase64('AA')).toBe(false) // dolžina % 4 != 0
    expect(isValidBase64('')).toBe(false) // prazno ni vsebina
    expect(isValidBase64('AA=A')).toBe(false) // padding na sredini
    expect(isValidBase64('AB!!')).toBe(false) // tuj znak
    expect(isValidBase64(null)).toBe(false)
    expect(base64SizeBytes('AAAA')).toBe(3)
    expect(base64SizeBytes('AAA=')).toBe(2)
    expect(base64SizeBytes('AA==')).toBe(1)
    expect(base64SizeBytes(PDF_CONTENT)).toBe(PDF_BYTES)
  })

  it('stripBase64DataUrl: FileReader data: URL odreže, čist base64 ostane', () => {
    const raw = `data:application/pdf;base64,${PDF_CONTENT}`
    expect(stripBase64DataUrl(raw)).toBe(PDF_CONTENT)
    expect(stripBase64DataUrl(PDF_CONTENT)).toBe(PDF_CONTENT)
  })

  it('safeFileName: pot ven, kontrolne znake ven, narekovaj ven, dolg trim; null za neuporabno', () => {
    expect(safeFileName('navodilo.pdf')).toBe('navodilo.pdf')
    expect(safeFileName('../../etc/passwd')).toBe('.-.-etc-passwd') // pot ven + .. skrčena — traversal nemogoč
    expect(safeFileName('C:\\Temp\\plan.docx')).toBe('C:-Temp-plan.docx')
    expect(safeFileName('ime\nz\ttabom.pdf')).toBe('imeztabom.pdf')
    expect(safeFileName('narekovaj".pdf')).toBe('narekovaj.pdf')
    expect(safeFileName('  presledki.pdf  ')).toBe('presledki.pdf')
    expect(safeFileName('x'.repeat(300))).toHaveLength(200)
    expect(safeFileName('')).toBeNull()
    expect(safeFileName('...')).toBeNull()
    expect(safeFileName(undefined)).toBeNull()
    expect(safeFileName(42)).toBeNull()
  })

  it('contentDispositionValue: attachment + ASCII fallback + UTF-8 percent (RFC 5987)', () => {
    expect(contentDispositionValue('plan.pdf')).toBe('attachment; filename="plan.pdf"; filename*=UTF-8\'\'plan.pdf')
    const sl = contentDispositionValue('priročnik.pdf')
    expect(sl.startsWith('attachment; filename="priro_nik.pdf";')).toBe(true)
    expect(sl).toContain(`filename*=UTF-8''${encodeURIComponent('priročnik.pdf')}`)
    expect(contentDispositionValue('a"b.pdf')).toContain('"a_b.pdf"')
  })

  it('parseDocumentInput: srečen tok + privzetki (sop, verzija 1 poštena ob pisanju rute)', () => {
    const r = parseDocumentInput({
      title: '  SOP pomivanje  ',
      category: ' navodilo ',
      description: 'Postopek za pomivanje',
      fileName: 'sop-pomivanje.pdf',
      mimeType: 'application/pdf',
      contentBase64: PDF_CONTENT,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({
      title: 'SOP pomivanje',
      category: 'navodilo',
      description: 'Postopek za pomivanje',
      fileName: 'sop-pomivanje.pdf',
      mimeType: 'application/pdf',
      contentBase64: PDF_CONTENT,
      sizeBytes: PDF_BYTES,
    })
    expect(MAX_DOCUMENT_BYTES).toBe(1_000_000)
  })

  it('parseDocumentInput: data: URL sprejet; brez kategorije → sop; opis null pošten', () => {
    const r = parseDocumentInput({
      title: 'SOP',
      fileName: 'plan.pdf',
      mimeType: 'application/pdf',
      contentBase64: `data:application/pdf;base64,${PDF_CONTENT}`,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.contentBase64).toBe(PDF_CONTENT)
      expect(r.value.category).toBe('sop')
      expect(r.value.description).toBeNull()
    }
  })

  it('parseDocumentInput: napake (naziv, dolg naziv, kategorija, opis, mime, base64, budget, ime)', () => {
    const okBody = { title: 'SOP', fileName: 'a.pdf', mimeType: 'application/pdf', contentBase64: PDF_CONTENT }
    expect(parseDocumentInput({}).ok).toBe(false)
    expect(parseDocumentInput({ ...okBody, title: '' }).ok).toBe(false)
    expect(parseDocumentInput({ ...okBody, title: 'x'.repeat(121) }).ok).toBe(false)
    expect(parseDocumentInput({ ...okBody, category: 'zemljevid' }).ok).toBe(false)
    expect(parseDocumentInput({ ...okBody, description: 'x'.repeat(501) }).ok).toBe(false)
    expect(parseDocumentInput({ ...okBody, mimeType: 'image/svg+xml' }).ok).toBe(false)
    expect(parseDocumentInput({ ...okBody, contentBase64: '' }).ok).toBe(false)
    expect(parseDocumentInput({ ...okBody, contentBase64: 'ne-veljaven!!' }).ok).toBe(false)
    expect(parseDocumentInput({ ...okBody, contentBase64: 'A'.repeat(1_400_000) }).ok).toBe(false) // ~1.05 MB > budget
    expect(parseDocumentInput({ ...okBody, fileName: '' }).ok).toBe(false)
    // path traversal NI zavrnjen ampak SANITIZIRAN (vsebina gre v bazo, ne na disk):
    const traversal = parseDocumentInput({ ...okBody, fileName: '../pot.pdf' })
    expect(traversal.ok && traversal.value.fileName === '.-pot.pdf').toBe(true)
    expect(parseDocumentInput(null).ok).toBe(false)
  })

  it('parseDocumentPatch: meta samostojno; cel paket; delni paket = napaka; brez sprememb = napaka', () => {
    const meta = parseDocumentPatch({ title: 'Nov naziv', category: 'pogodba', description: null })
    expect(meta.ok).toBe(true)
    if (meta.ok) {
      expect(meta.value.title).toBe('Nov naziv')
      expect(meta.value.category).toBe('pogodba')
      expect(meta.value.description).toBeNull()
    }
    const full = parseDocumentPatch({ fileName: 'b.png', mimeType: 'image/png', contentBase64: PNG_CONTENT })
    expect(full.ok).toBe(true)
    if (full.ok) {
      expect(full.value.sizeBytes).toBe(PNG_BYTES)
    }
    // delni paket — vsaka kombinacija brez tretjega je napaka (atomsko)
    expect(parseDocumentPatch({ fileName: 'b.png' }).ok).toBe(false)
    expect(parseDocumentPatch({ mimeType: 'image/png' }).ok).toBe(false)
    expect(parseDocumentPatch({ contentBase64: PNG_CONTENT }).ok).toBe(false)
    expect(parseDocumentPatch({ fileName: 'b.png', mimeType: 'image/png' }).ok).toBe(false)
    // prazno / neveljavno
    expect(parseDocumentPatch({}).ok).toBe(false)
    expect(parseDocumentPatch({ title: '' }).ok).toBe(false)
    expect(parseDocumentPatch({ category: 'zemljevid' }).ok).toBe(false)
    expect(parseDocumentPatch({ title: 'A', mimeType: 'image/svg+xml', fileName: 'a', contentBase64: PNG_CONTENT }).ok).toBe(false)
    expect(parseDocumentPatch(null).ok).toBe(false)
  })

  it('documentDto: pure preslikava, content NIKOLI v DTO', () => {
    const row = {
      id: 'd1', locationId: 'loc', title: 'SOP', category: 'sop', description: null,
      fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 42, version: 3,
      createdAt: new Date('2026-03-01T00:00:00Z'), updatedAt: new Date('2026-03-02T00:00:00Z'),
      createdById: null, updatedById: null,
    }
    const dto = documentDto(row)
    expect(dto.version).toBe(3)
    expect(dto.createdAt).toBe('2026-03-01T00:00:00.000Z')
    expect(Object.keys(dto)).not.toContain('content')
    expect(Object.keys(dto)).not.toContain('contentBase64')
  })

  it('humanSize: B / kB / MB (deterministično)', () => {
    expect(humanSize(500)).toBe('500 B')
    expect(humanSize(1500)).toBe('1.5 kB')
    expect(humanSize(1_500_000)).toBe('1.5 MB')
  })
})

/* ═══════════════════ Č2. BACKEND ═══════════════════ */

describe('Č2 backend dokumentov', () => {
  let docA = ''
  let docB = ''

  it('401 brez žetona (GET, POST, PATCH, DELETE, download)', async () => {
    expect((await documentsGET(req('GET', '/api/documents', null))).status).toBe(401)
    expect((await documentsPOST(req('POST', '/api/documents', null, { title: 'X' }))).status).toBe(401)
    expect((await documentsPATCH(req('PATCH', '/api/documents/x', null, { title: 'X' }), params('x'))).status).toBe(401)
    expect((await documentsDELETE(req('DELETE', '/api/documents/x', null), params('x'))).status).toBe(401)
    expect((await downloadGET(req('GET', '/api/documents/x/download', null), params('x'))).status).toBe(401)
  })

  it('503 do DDL (probe false — eksplicitno, vsaka ruta)', async () => {
    __setDocumentsTableReadyForTests(false)
    try {
      expect((await documentsGET(req('GET', '/api/documents', tok))).status).toBe(503)
      expect((await documentsPOST(req('POST', '/api/documents', tok, { title: 'X' }))).status).toBe(503)
      expect((await documentsPATCH(req('PATCH', '/api/documents/x', tok, { title: 'X' }), params('x'))).status).toBe(503)
      expect((await documentsDELETE(req('DELETE', '/api/documents/x', tok), params('x'))).status).toBe(503)
      expect((await downloadGET(req('GET', '/api/documents/x/download', tok), params('x'))).status).toBe(503)
    } finally {
      __setDocumentsTableReadyForTests(true)
    }
  })

  it('POST ustvari dokument (201, verzija 1) + audit DOCUMENT_CREATE; DTO brez vsebine', async () => {
    const r = await documentsPOST(req('POST', '/api/documents', tok, {
      title: `${P}SOP pomivanje`,
      category: 'navodilo',
      description: 'Postopek pomivanja ustreznik',
      fileName: 'sop-pomivanje.pdf',
      mimeType: 'application/pdf',
      contentBase64: PDF_CONTENT,
    }))
    expect(r.status).toBe(201)
    const j = await body(r)
    const doc = j.document as Record<string, unknown>
    docA = String(doc.id)
    expect(doc.title).toBe(`${P}SOP pomivanje`)
    expect(doc.category).toBe('navodilo')
    expect(doc.version).toBe(1)
    expect(doc.sizeBytes).toBe(PDF_BYTES)
    expect(doc.fileName).toBe('sop-pomivanje.pdf')
    expect(Object.keys(doc)).not.toContain('content')
    const row = await db.document.findUnique({ where: { id: docA } })
    expect(row).not.toBeNull()
    expect(Buffer.from(row!.content).toString()).toBe('%PDF-1.4 testni dokument v203')
    const audit = await db.auditLog.findFirst({ where: { action: 'DOCUMENT_CREATE', entityId: docA } })
    expect(audit).not.toBeNull()
  })

  it('POST: brez kategorije → sop; data: URL sprejet; MIME SVG → 400; prevelik → 400', async () => {
    const r = await documentsPOST(req('POST', '/api/documents', tok, {
      title: `${P}SOP privzeta kategorija`,
      fileName: 'plan.pdf',
      mimeType: 'application/pdf',
      contentBase64: `data:application/pdf;base64,${PDF_CONTENT}`,
    }))
    expect(r.status).toBe(201)
    const j = await body(r)
    const doc = j.document as Record<string, unknown>
    expect(doc.category).toBe('sop')
    docB = String(doc.id)

    expect((await documentsPOST(req('POST', '/api/documents', tok, {
      title: 'XSS poskus', fileName: 'x.svg', mimeType: 'image/svg+xml', contentBase64: PNG_CONTENT,
    }))).status).toBe(400)
    expect((await documentsPOST(req('POST', '/api/documents', tok, {
      title: 'Velik', fileName: 'velik.pdf', mimeType: 'application/pdf', contentBase64: 'A'.repeat(1_400_000),
    }))).status).toBe(400)
    expect((await documentsPOST(req('POST', '/api/documents', tok, { title: 'Brez datoteke' }))).status).toBe(400)
  })

  it('403: waiter brez settings.manage ne ustvari', async () => {
    expect((await documentsPOST(req('POST', '/api/documents', waiterToken, {
      title: 'X', fileName: 'a.pdf', mimeType: 'application/pdf', contentBase64: PDF_CONTENT,
    }))).status).toBe(403)
  })

  it('GET obseg: manager svoja lokacija; admin org + lokacije; waiter vidi (vse vloge branje); category filter', async () => {
    const jm = await body(await documentsGET(req('GET', '/api/documents', tok)))
    const idsM = (jm.documents as Record<string, unknown>[]).map((x) => String(x.id))
    expect(idsM).toContain(docA)
    expect(idsM).toContain(docB)

    const jw = await body(await documentsGET(req('GET', '/api/documents', waiterToken)))
    const idsW = (jw.documents as Record<string, unknown>[]).map((x) => String(x.id))
    expect(idsW).toContain(docA)

    const ja = await body(await documentsGET(req('GET', '/api/documents', adminToken)))
    const idsA = (ja.documents as Record<string, unknown>[]).map((x) => String(x.id))
    expect(idsA).toContain(docA)
    const locs = (ja.locations as { id: string }[]).map((l) => l.id)
    expect(locs).toContain(locA)

    const jf = await body(await documentsGET(req('GET', '/api/documents?category=navodilo', tok)))
    const idsF = (jf.documents as Record<string, unknown>[]).map((x) => String(x.id))
    expect(idsF).toContain(docA)
    expect(idsF).not.toContain(docB)
  })

  it('PATCH metapodatki: verzija OSTANE; PATCH cel paket: verzija +1 + audit DOCUMENT_UPDATED', async () => {
    const meta = await documentsPATCH(req('PATCH', `/api/documents/${docA}`, tok, { title: 'SOP pomivanje v2', category: 'pogodba' }), params(docA))
    expect(meta.status).toBe(200)
    const jm = await body(meta)
    expect((jm.document as Record<string, unknown>).version).toBe(1)
    expect((jm.document as Record<string, unknown>).category).toBe('pogodba')

    const full = await documentsPATCH(req('PATCH', `/api/documents/${docA}`, tok, {
      fileName: 'sop-pomivanje-v2.png',
      mimeType: 'image/png',
      contentBase64: PNG_CONTENT,
    }), params(docA))
    expect(full.status).toBe(200)
    const jf = await body(full)
    const doc = jf.document as Record<string, unknown>
    expect(doc.version).toBe(2)
    expect(doc.fileName).toBe('sop-pomivanje-v2.png')
    expect(doc.sizeBytes).toBe(PNG_BYTES)
    const audit = await db.auditLog.findFirst({ where: { action: 'DOCUMENT_UPDATED', entityId: docA } })
    expect(audit).not.toBeNull()
  })

  it('PATCH: brez sprememb → 400; delni paket → 400; neznani id → 404', async () => {
    expect((await documentsPATCH(req('PATCH', `/api/documents/${docA}`, tok, {}), params(docA))).status).toBe(400)
    expect((await documentsPATCH(req('PATCH', `/api/documents/${docA}`, tok, { fileName: 'solo.png' }), params(docA))).status).toBe(400)
    expect((await documentsPATCH(req('PATCH', '/api/documents/ni-kje', tok, { title: 'X' }), params('ni-kje'))).status).toBe(404)
    expect((await documentsDELETE(req('DELETE', '/api/documents/ni-kje', tok), params('ni-kje'))).status).toBe(404)
  })

  it('download: attachment + nosniff + private no-store; vsebina byte-točna (round-trip)', async () => {
    const r = await downloadGET(req('GET', `/api/documents/${docA}/download`, tok), params(docA))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('content-disposition')).toContain('attachment; filename="sop-pomivanje-v2.png"')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('cache-control')).toBe('private, no-store')
    expect(r.headers.get('content-length')).toBe(String(PNG_BYTES))
    const bytes = Buffer.from(await r.arrayBuffer()).toString()
    expect(bytes).toBe('PNG-podatki za zamenjavo v203')
  })

  it('tuja lokacija: manager (locA) ne patcha/deletea/downloada dokumenta na locB (403)', async () => {
    const alien = await db.document.create({
      data: {
        id: `${P}docB-${RUN}`,
        locationId: locB,
        title: `${P}Tuj dokument`,
        category: 'sop',
        fileName: 'tuj.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF_BYTES,
        content: new Uint8Array(Buffer.from(PDF_CONTENT, 'base64')),
        version: 1,
        createdById: `${P}seed-${RUN}`,
      },
    })
    expect((await documentsPATCH(req('PATCH', `/api/documents/${alien.id}`, tok, { title: 'Prevzem' }), params(alien.id))).status).toBe(403)
    expect((await documentsDELETE(req('DELETE', `/api/documents/${alien.id}`, tok), params(alien.id))).status).toBe(403)
    expect((await downloadGET(req('GET', `/api/documents/${alien.id}/download`, waiterToken), params(alien.id))).status).toBe(403)
    await db.document.delete({ where: { id: alien.id } })
  })

  it('DELETE pobriše dokument (vsebina v istem zapisu) + audit DOCUMENT_DELETED', async () => {
    const r = await documentsDELETE(req('DELETE', `/api/documents/${docB}`, adminToken), params(docB))
    expect(r.status).toBe(200)
    expect(await db.document.findUnique({ where: { id: docB } })).toBeNull()
    const audit = await db.auditLog.findFirst({ where: { action: 'DOCUMENT_DELETED', entityId: docB } })
    expect(audit).not.toBeNull()
  })
})

/* ═══════════════════ Č3. DDL RUTA ═══════════════════ */

describe('Č3 DDL ruta migrate-documents', () => {
  it('403 za managerja (requireCentralRole)', async () => {
    expect((await migratePOST(req('POST', '/api/admin/migrate-documents', tok, {}))).status).toBe(403)
  })

  it('200 za admina — na SQLite tabela že prek db push → skipped + audit', async () => {
    const r = await migratePOST(req('POST', '/api/admin/migrate-documents', adminToken, {}))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(j.alreadyApplied).toBe(true)
    expect(j.skipped as string[]).toEqual(['Document'])
    const audit = await db.auditLog.findFirst({ where: { action: 'SCHEMA_MIGRATION_DOCUMENTS' } })
    expect(audit).not.toBeNull()
  })
})

/* ═══════════════════ Č4. UI STATIKA + REGISTRI + VERZIJA ═══════════════════ */

describe('Č4 registri, i18n in verzija', () => {
  it('SCHEMA_MIGRATIONS: 36. vnos documents (descKey/endpoint/probe)', () => {
    expect(SCHEMA_MIGRATIONS).toHaveLength(36) // v1.203.0: +documents (OSS-2)
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'documents')
    expect(m).toBeDefined()
    expect(m?.descKey).toBe('mig.documents.desc')
    expect(m?.endpoint).toBe('/api/admin/migrate-documents')
    expect(typeof m?.probe).toBe('function')
  })

  it('drift allowlist: 28 vnosov; CREATE TABLE Document + indeksi so znan drift', () => {
    expect(KNOWN_DRIFTS).toHaveLength(28) // v1.203.0: +documents (OSS-2)
    const cls = classifyDrift(
      'CREATE TABLE "Document" ("id" TEXT NOT NULL, "locationId" TEXT NOT NULL, "content" BYTEA NOT NULL, CONSTRAINT "Document_pkey" PRIMARY KEY ("id"));\n' +
        'CREATE INDEX "Document_locationId_idx" ON "Document"("locationId");\n' +
        'CREATE INDEX "Document_category_idx" ON "Document"("category");',
    )
    expect(cls.unexpected).toEqual([])
    expect(cls.known.map((k) => k.id)).toEqual(['documents'])
    expect(classifyDrift('CREATE TABLE "Backdoor" ("id" TEXT NOT NULL);').unexpected).toHaveLength(1)
  })

  it('model v OBEH shemah + baseline migracija nosi tabelo in indeksa', () => {
    const prod = readFileSync('prisma/schema.prisma', 'utf8')
    const sqlite = readFileSync('prisma/schema.sqlite.prisma', 'utf8')
    const migration = readFileSync('prisma/migrations/00000000000000_init/migration.sql', 'utf8')
    for (const s of [prod, sqlite]) {
      expect(s).toContain('model Document {')
      expect(s).toContain('content     Bytes')
    }
    expect(migration).toContain('CREATE TABLE "Document"')
    expect(migration).toContain('"content" BYTEA NOT NULL')
    expect(migration).toContain('CREATE INDEX "Document_locationId_idx"')
    expect(migration).toContain('CREATE INDEX "Document_category_idx"')
  })

  it('i18n pariteta: doc.* (28 ključev) + mig.documents.desc v SL in HR', () => {
    const slDoc = Object.keys(sl).filter((k) => k.startsWith('doc.')).sort()
    const hrDoc = Object.keys(hr).filter((k) => k.startsWith('doc.')).sort()
    expect(slDoc.length).toBe(28)
    expect(hrDoc).toEqual(slDoc)
    for (const k of slDoc) {
      expect(String(sl[k]).length).toBeGreaterThan(0)
      expect(String(hr[k]).length).toBeGreaterThan(0)
    }
    expect(sl['mig.documents.desc']).toBeDefined()
    expect(hr['mig.documents.desc']).toBeDefined()
  })

  it('UI statika: kartica + barrel + montaža v Nastavitve → Operacija', () => {
    const card = readFileSync('src/components/tabs/documents-card.tsx', 'utf8')
    expect(card).toContain("t('doc.title')")
    expect(card).toContain("t('doc.download')")
    expect(card).toContain('/api/documents')
    const barrel = readFileSync('src/components/dashboard-tabs.tsx', 'utf8')
    expect(barrel).toContain("export { DocumentsCard } from './tabs/documents-card'")
    const page = readFileSync('src/app/dashboard/page.tsx', 'utf8')
    expect(page).toContain('<DocumentsCard />')
  })

  it('verzija 1.212.0', () => {
    expect(APP_VERSION).toBe('1.212.0')
  })
})
