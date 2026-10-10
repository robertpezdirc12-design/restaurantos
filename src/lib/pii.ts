/**
 * PII zaščita (P2 audit — loyalty): maskiranje telefonskih številk v seznamih.
 *
 * Politika: seznam zvestobe (GET /api/loyalty) VEDNO vrača maskirane telefone
 * (npr. »+386 *** 567«) — polna številka je osebni podatek (GDPR) in ni
 * potrebna za delo s seznamom. Nezakrit varianti dostopa samo prek
 * ?full=1 z dovoljenjem settings.manage (izvoz/admin potreba).
 *
 * Maskiranje je nepovratno prikazovanje: ohrani državno predpono (če obstaja)
 * in zadnjih 3 števk; sredina je skrita.
 */
export function maskPhone(value: string | null | undefined): string | null {
  const s = String(value ?? '').trim()
  if (!s) return null
  const digits = s.replace(/\D/g, '')
  if (digits.length < 4) return '***'
  const last3 = digits.slice(-3)
  // državna predpona: vodilni '+' + do 3 števk (npr. »+386 «) — ostalo zakrijemo
  const cc = s.startsWith('+') ? `${s.slice(0, 4).replace(/[^\d+]/g, '')} ` : ''
  return `${cc}*** ${last3}`
}
