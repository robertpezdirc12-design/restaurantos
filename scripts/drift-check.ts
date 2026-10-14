#!/usr/bin/env bun
/**
 * Task 45: Schema drift check s "known-issue" allowlist.
 *
 * Pokaže se kot CI korak v .github/workflows/ci.yml (job neon-smoke) in
 * primerja produkcijsko kopijo sheme (Neon ephemeral branch od prod) z
 * prisma/schema.prisma. Razlikuje TRI izide:
 *
 *   1. brez drifta          → exit 0 (zelena)
 *   2. SAMO znani pending drift → exit 0 + ::warning:: anotacija (rumena)
 *      — trenutno issue-13: Location.premisesId nullable (Task 44), produkcija
 *      čaka na uporabniški DDL korak (admin ruta /api/admin/migrate-issue13).
 *      Rdeči CI na vsakem commitu bi učil tim ignoriranja rdečega CI in
 *      utišal prave regresije; allowlist to odpravi, VSAK drug drift pa
 *      ostane hard fail.
 *   3. nepričakovan drift ALI infra napaka → exit 1 (rdeča, blokator)
 *
 * Uporaba:
 *   bun scripts/drift-check.ts <from-url> <schema.prisma>
 *
 * Exit kodi prisma migrate diff --exit-code:
 *   0 = brez razlik · 2 = razlike obstajajo (SQL na stdout) · 1 = napaka
 *
 * Pisanje v $GITHUB_STEP_SUMMARY in GitHub anotacije se izvede le, če
 * spremenljivka obstaja (lokalni zagon izpiše vse na stdout).
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

/** Normaliziran SQL stavek: brez komentarjev/praznih vrstic, en sam presledek. */
export function parseStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .map((line) => line.replace(/^\s*--.*$/, ''))
    .join('\n')
  return withoutComments
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Issue-13 (Task 44): Location.premisesId je v datamodelu `String? @unique`,
 * produkcija pa še vedno NOT NULL DEFAULT ''. Prisma diff generira (lokalno
 * replikirano, deterministično):
 *
 *   -- AlterTable
 *   ALTER TABLE "Location" ALTER COLUMN "premisesId" DROP NOT NULL,
 *   ALTER COLUMN "premisesId" DROP DEFAULT;
 *
 * (prav tako sprejmemo razdvojeni dva stavka — enaka semantika)
 */
export function isIssue13Statement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"Location"\s+([\s\S]+)$/i.exec(stmt)
  if (!m) return false
  const clauses = m[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  if (clauses.length === 0) return false
  return clauses.every((c) =>
    /^ALTER\s+COLUMN\s+"premisesId"\s+(DROP\s+NOT\s+NULL|DROP\s+DEFAULT)$/i.test(c),
  )
}

export interface KnownDrift {
  id: string
  reason: string
  matches(stmt: string): boolean
}

/**
 * Task 66 (v1.64.0): stroški kategorije — stolpec "category" na AccountsPayable
 * je v fazi DDL-drafta (main schema.prisma polja ŠE nima; dev zrcalo ga ima).
 * Diff (Neon → main schema) lahko generira DVA smeri, odvisno od faze:
 *  - faza B (uporabnik je apliciral DDL, main schema še brez polja):
 *      ALTER TABLE "AccountsPayable" DROP COLUMN "category";
 *  - faza C' (naslednja naloga doda polje v main schema, DDL še ni apliciran):
 *      ALTER TABLE "AccountsPayable" ADD COLUMN "category" TEXT NOT NULL DEFAULT '';
 * Matcher je STROG (po vzoru isIssue13Statement): tabela + VSAKA klavzula mora
 * biti točno ADD/DROP COLUMN "category" — kombiniran ALTER z dodatnimi stolpci
 * ostane unexpected. Narekovaji preprečujejo lažne ujeme ("AccountsPayableLine",
 * "category_id"). Ko sta polje in DDL usklajena (faza C), drift izgine in vnos
 * postane mrtva koda.
 */
export function isStroskiKategorijeStatement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"AccountsPayable"\s+([\s\S]+)$/i.exec(stmt)
  if (!m) return false
  const clauses = m[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  if (clauses.length === 0) return false
  return clauses.every((c) => /^(ADD|DROP)\s+COLUMN\s+"category"(\s|$)/i.test(c))
}

/**
 * Task 64 (v1.62.0): HaccpPlan tabela — prisma diff generira CREATE TABLE +
 * 2× CREATE INDEX + ADD CONSTRAINT (FK na Location). Vsi 4 stavki vsebujejo
 * "HaccpPlan" (noben drug model se nanjo veže), zato je matcher preprost in
 * strog hkrati: samo DDL-ključne besede + ime tabele.
 */
export function isHaccpPlanStatement(stmt: string): boolean {
  if (!/"HaccpPlan"/.test(stmt)) return false
  return /^(CREATE\s+TABLE|CREATE\s+INDEX|ALTER\s+TABLE)\b/i.test(stmt)
}

/** v1.85.1 (P0-2): PayLink tabela — isti vzorec kot HaccpPlan (vsi stavki vsebujejo ime). */
export function isPayLinkStatement(stmt: string): boolean {
  if (!/"PayLink"/.test(stmt)) return false
  return /^(CREATE\s+TABLE|CREATE\s+INDEX|ALTER\s+TABLE)\b/i.test(stmt)
}

/** v1.87.0 (P1-6): split po gostih — ALTER TABLE ADD COLUMN + DROP INDEX nad PayLink. */
export function isPayLinkSplitStatement(stmt: string): boolean {
  if (!/"PayLink"/.test(stmt)) return false
  return /^(ALTER\s+TABLE|DROP\s+INDEX)\b/i.test(stmt)
}

/**
 * v1.94.0 (issue #31–36): aditivna MFA stolpca nad Employee — mfaLastTotpCounter
 * (TOTP replay zaščita, RFC 6238 §5.2) + mfaRecoveryVersion (CAS za atomarno
 * porabo recovery kod). Prepozna ALTER TABLE "Employee" z SAMO tema dvema
 * dodatnima stolpcema (druge spremembe Employee ostanejo nepričakovani drift).
 */
export function isIssue31_36MfaStatement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"Employee"\s+([\s\S]+)$/i.exec(stmt)
  if (!m) return false
  const clauses = m[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  if (clauses.length === 0) return false
  return clauses.every((c) =>
    /^ADD\s+COLUMN\s+"(mfaLastTotpCounter|mfaRecoveryVersion)"(\s|$)/i.test(c)
  )
}

/** Register znanih, dokumentiranih pending driftov. Novi vnosi dodajaj tukaj. */
export const KNOWN_DRIFTS: KnownDrift[] = [
  {
    id: 'issue-13',
    reason:
      'Location.premisesId nullable migracija (Task 44) — produkcija čaka na uporabniški ' +
      'DDL korak: admin ruta /api/admin/migrate-issue13 (docs/RESTAURANTOS-AUDIT.md §13). ' +
      'Produkcija deluje normalno (aditivno-varno).',
    matches: isIssue13Statement,
  },
  {
    id: 'haccp-plans',
    reason:
      'HaccpPlan tabela (Task 64, v1.62.0) — produkcija čaka DDL korak: admin ruta ' +
      '/api/admin/migrate-haccp-plans (issue-13 vzorec, requireCentralRole). Rute ' +
      '/api/haccp/plans** graceful degradirajo (capability probe → ddlPending/503); ' +
      'nobena živa funkcionalnost ne uporablja nove tabele. Ko je DDL apliciran, ' +
      'drift izgine in ta vnos postane mrtva koda (brez spremembe workflowa).',
    matches: isHaccpPlanStatement,
  },
  {
    id: 'paylink',
    reason:
      'PayLink tabela (v1.85.0, P0-2 — javna plačilna povezava /pay/<token>) — ' +
      'produkcija čaka DDL korak: admin ruta /api/admin/migrate-paylink (konzola ' +
      'Enterprise → Shema migracije → en klik). Rute /api/orders/[id]/paylink in ' +
      '/api/public/pay/[token] graceful degradirajo (capability probe → 503 s ' +
      'prijaznim sporočilom); PayLink povezave se ZAČNEJO uporabljati šele po DDL ' +
      '(ustvari jih osebje — pred tem ne obstajajo). Ko je DDL apliciran, drift ' +
      'izgine in ta vnos postane mrtva koda.',
    matches: isPayLinkStatement,
  },
  {
    id: 'paylink-split',
    reason:
      'PayLink split po gostih (P1-6, v1.87.0 — N povezav na naročilo) — ' +
      'produkcija čaka DDL korak: admin ruta /api/admin/migrate-paylink-split ' +
      '(konzola Enterprise → Shema migracije → en klik; DROP orderId unique + ' +
      'splitIndex/splitCount/approvalCode stolpci). Do DDL obstoječe PayLink ' +
      'poizvedbe delujejo (stolpci imajo varne defaulte v Prisma klientu — ' +
      'poizvedbe z novimi stolpci vrnejo P2022/P2010 → rute 503 degradirajo ' +
      'prek payLinkReady probe). Ko je DDL apliciran, drift izgine.',
    matches: isPayLinkSplitStatement,
  },
  {
    id: 'stroski-kategorije',
    reason:
      'Stroški kategorije — stolpec AccountsPayable."category" (Task 66, v1.64.0, ' +
      'DDL draft): admin ruta /api/admin/migrate-stroski-kategorije (konzola ' +
      'Enterprise → en klik). Faza je dvosmerna (glej isStroskiKategorijeStatement): ' +
      'po uporabniškem DDL (stolpec v Neonu, main schema še brez) diff generira ' +
      'DROP COLUMN; po naslednji nalogi (polje v main schema, DDL še ne apliciran) ' +
      'ADD COLUMN. Nobena živa poizvedba ne uporablja stolpca v obeh fazah — ' +
      'produkcija deluje normalno. Ko je oboje usklajeno, drift izgine (mrtva koda).',
    matches: isStroskiKategorijeStatement,
  },
  {
    id: 'issue31-36-mfa',
    reason:
      'MFA utrjevanje (v1.94.0, issue #31–36) — Employee.mfaLastTotpCounter ' +
      '(RFC 6238 §5.2 TOTP replay zaščita) + Employee.mfaRecoveryVersion (CAS ' +
      'atomarna poraba recovery kod): produkcija čaka DDL korak — admin ruta ' +
      '/api/admin/migrate-issue31-36 (konzola Enterprise → Shema migracije → ' +
      'en klik). Do DDL: običajne prijave BREZ MFA so neprizadete (pisajo samo ' +
      'obstoječa polja), MFA poti (enroll/enable/disable, prijava mfaEnabled ' +
      'računov) pa pišejo v nove stolpce → P2022 → 500. DDL aplicirajmo TAKOJ ' +
      'po deployu (idempotentno, IF NOT EXISTS).',
    matches: isIssue31_36MfaStatement,
  },
]

export interface DriftClassification {
  known: { id: string; reason: string; statements: string[] }[]
  unexpected: string[]
}

/** Razvrsti drift SQL na znane (allowlist) in nepričakovane (blokator) stavke. */
export function classifyDrift(
  sql: string,
  known: KnownDrift[] = KNOWN_DRIFTS,
): DriftClassification {
  const result: DriftClassification = { known: [], unexpected: [] }
  for (const stmt of parseStatements(sql)) {
    const hit = known.find((k) => k.matches(stmt))
    if (hit) {
      let bucket = result.known.find((k) => k.id === hit.id)
      if (!bucket) {
        bucket = { id: hit.id, reason: hit.reason, statements: [] }
        result.known.push(bucket)
      }
      bucket.statements.push(stmt)
    } else {
      result.unexpected.push(stmt)
    }
  }
  return result
}

export interface DiffResult {
  status: number
  stdout: string
  stderr: string
}

/** Zaženi prisma migrate diff --exit-code in vrni { status, stdout, stderr }. */
export function runDiff(fromUrl: string, schemaPath: string): DiffResult {
  try {
    const stdout = execFileSync(
      'bunx',
      [
        'prisma',
        'migrate',
        'diff',
        '--from-url',
        fromUrl,
        '--to-schema-datamodel',
        schemaPath,
        '--script',
        '--exit-code',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 },
    )
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return {
      status: typeof err.status === 'number' ? err.status : -1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    }
  }
}

function summaryAppend(md: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (path) {
    try {
      appendFileSync(path, md)
    } catch {
      /* summary je nekritičen */
    }
  }
}

function annotation(level: 'warning' | 'error', message: string): void {
  // GitHub workflow command — v lokalnem okolju je neškodljiv izpis
  console.log(`::${level}::${message}`)
}

async function main(): Promise<number> {
  const [fromUrl, schemaPath] = process.argv.slice(2)
  if (!fromUrl || !schemaPath) {
    console.error('uporaba: bun scripts/drift-check.ts <from-url> <schema.prisma>')
    return 2
  }

  const diff = runDiff(fromUrl, schemaPath)

  // 1) brez drifta
  if (diff.status === 0) {
    console.log('✅ No drift: production schema matches prisma datamodel')
    summaryAppend('### ✅ Schema drift check: no drift (production copy matches datamodel)\n')
    return 0
  }

  // 2) infra napaka (npr. P1001 unreachable) — LOČENO od drifta, vedno blokator
  if (diff.status === 1) {
    const msg = `drift check infrastructure failure (prisma exit 1): ${diff.stderr.slice(0, 400).trim()}`
    console.error(`❌ ${msg}`)
    summaryAppend(`### 🔴 Schema drift check: INFRA NAPAKA (ne drift)\n\n\`\`\`\n${diff.stderr.slice(0, 800)}\n\`\`\`\n`)
    annotation('error', msg)
    return 1
  }

  // 3) drift obstaja (prisma exit 2) → klasificiraj
  if (diff.status !== 2) {
    const msg = `drift check: nepričakovan prisma exit ${diff.status}`
    console.error(`❌ ${msg}: ${diff.stderr.slice(0, 300)}`)
    summaryAppend(`### 🔴 Schema drift check: ${msg}\n\n\`\`\`\n${diff.stderr.slice(0, 800)}\n\`\`\`\n`)
    annotation('error', msg)
    return 1
  }

  const cls = classifyDrift(diff.stdout)

  if (cls.unexpected.length === 0 && cls.known.length === 0) {
    // exit 2, a nič parsanega — brani se: tretjaj kot nepričakovan drift
    const raw = diff.stdout.trim()
    const msg = 'prisma je javil drift, a izhoda ni bilo mogoče parsati'
    console.error(`❌ ${msg}. Raw:\n${raw.slice(0, 800)}`)
    summaryAppend(`### 🔴 Schema drift check: ${msg}\n\n\`\`\`\n${raw.slice(0, 1200)}\n\`\`\`\n`)
    annotation('error', msg)
    return 1
  }

  let md = ''
  for (const k of cls.known) {
    const lines = [
      `### ⚠️ Znan pending drift: ${k.id} (dovoljen — NI blokator)`,
      '',
      k.reason,
      '',
      '```sql',
      ...k.statements.slice(0, 20),
      '```',
      '',
    ]
    md += lines.join('\n')
    console.log(lines.join('\n'))
    annotation('warning', `Schema drift (KNOWN): ${k.id} — ${k.statements.length} stavek/ov, nepričakovanih: 0`)
  }

  if (cls.unexpected.length > 0) {
    const lines = [
      '### 🔴 Schema drift: NEPRIČAKOVAN drift — pushaj ne (produkcija tvega)',
      '',
      '```sql',
      ...cls.unexpected.slice(0, 40),
      '```',
      '',
    ]
    md += lines.join('\n')
    console.error(lines.join('\n'))
    annotation('error', `NEPRIČAKOVAN schema drift: ${cls.unexpected.length} stavek/ov`)
  }

  summaryAppend(md)

  if (cls.unexpected.length > 0) return 1

  console.log(
    `✅ Drift check PASSED: samo znani pending drift(i) (${cls.known.map((k) => k.id).join(', ')}) — nepričakovanih 0`,
  )
  return 0
}

// bun test importa module brez zagona main
if (import.meta.main) {
  process.exit(await main())
}
