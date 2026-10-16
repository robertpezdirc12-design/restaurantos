/**
 * Issue #70 §3 (P1, v1.121.0) — semantika sekcij zavihka Dostava.
 *
 * VŽIVI vzrok (produkcija v1.119.0, demo): sekcija "Zaključene dostave" je
 * vsebovala zapise z oznako OPEN. Filter je bil:
 *   active = o.delivery && o.delivery.status !== 'DELIVERED' && ... !== 'CANCELLED'
 * → dostavno naročilo BREZ DeliveryInfo (zastareli demo zapisi, status OPEN)
 * NI bilo "aktivno" → padlo je v "zaključene dostave", kjer je oznaka padla
 * nazaj na surov status NAROČILA ("OPEN").
 *
 * REŠITEV: ZGODOVINA = SAMO terminalni zapisi — naročilo PLAČANO/PREKLICANA
 * ali dostava DOSTAVLJENA/PREKLICANA. Naročilo brez dostavnih podatkov je
 * pošteno AKTIVNO (ni zaključeno) in dobijo v UI kompaktno kartico z opombo
 * 'dost.noInfo' (brez prehodov — PATCH /api/delivery za take zapise vrne 404).
 *
 * Modul je ČIST (brez uvozov) — varen za client bundle in enotsko testiran.
 */

/** Je dostavno naročilo AKTIVNO (še v toku) ali terminalno (zgodovina)? */
export function deliveryOrderIsActive(
  order: { status: string; delivery: { status: string } | null }
): boolean {
  if (order.status === 'PAID' || order.status === 'CANCELLED') return false
  if (!order.delivery) return true
  return order.delivery.status !== 'DELIVERED' && order.delivery.status !== 'CANCELLED'
}
