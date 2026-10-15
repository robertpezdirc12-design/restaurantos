import { NextRequest } from 'next/server'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { exceptionPolicy } from '@/lib/exception-policy'
import { isManagerialRole } from '@/lib/exception-approval'

/**
 * Issue #19 (v1.107.0) — GET /api/exception-policy
 *
 * Lahek, BREZ skrivnosti vir politike finančnih izjem za POS UI (requireAuth —
 * vsak prijavljeni; vsebuje SAMO pragove/bool konfiguracijo, ki je sicer vidna
 * v toku POS-a prek strežniških zavrnitev). UI tako VEDE, kdaj odpreti dialog
 * razloga/odobritve PRED klicem (strežnik ostaja avtoritativen — vsak klic
 * validira sam).
 *
 * Odgovor: { policy: {...9 vrednosti}, isManagerial: boolean } — isManagerial
 * pove, ali vloga izvajalca sama šteje za odobritev ('role').
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const policy = await exceptionPolicy()
  return ok({ policy, isManagerial: isManagerialRole(user.role) })
}
