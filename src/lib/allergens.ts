/**
 * OPS-9 val 3 (v1.76.0) — QR menu allergen filter (pure helpers, no DB).
 *
 * Data reality (zero DDL): MenuItem.allergens is a freeform String column
 * (production schema L1378, default ''). The QR menu (/m/[token]) already renders
 * it verbatim as "Alergeni: {allergens}", so the practical write format is a
 * comma-separated label string (e.g. "gluten, laktoza"). These helpers parse that
 * format tolerantly (also JSON arrays, semicolons, slashes — defensive), build the
 * chip union across items and apply the client-side exclusion filter:
 * selecting a chip HIDES every item containing that allergen.
 */

/**
 * Parse one item's allergens value into a label list.
 *  - '' / null / undefined → []
 *  - 'gluten, laktoza' → ['gluten', 'laktoza'] (comma/semicolon/slash separators)
 *  - '["gluten","laktoza"]' (JSON array string) → ['gluten', 'laktoza']
 *  - deduped case-insensitively, first casing wins, never throws.
 */
export function parseAllergens(raw: unknown): string[] {
  // Defensively accept an already-parsed array (e.g. Json column value passed straight in)
  if (Array.isArray(raw)) {
    return dedupeLabels(raw.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean))
  }
  if (typeof raw !== 'string') return []
  const s = raw.trim()
  if (!s) return []
  // JSON array string (defensive — the column is a String, someone may store JSON)
  if (s.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(s)
      if (Array.isArray(parsed)) {
        return dedupeLabels(parsed.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean))
      }
      return []
    } catch {
      /* fall through to separator parsing */
    }
  }
  return dedupeLabels(
    s
      .split(/[,;\/|]/)
      .map((x) => x.trim())
      .filter(Boolean),
  )
}

function dedupeLabels(labels: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of labels) {
    const key = l.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(l)
  }
  return out
}

/** Union of allergen labels across items (chip set); preserves first-seen casing/order. */
export function allergenUnion<T>(items: T[], allergensOf: (item: T) => unknown): string[] {
  const out: string[] = []
  for (const it of items) out.push(...parseAllergens(allergensOf(it)))
  return dedupeLabels(out)
}

/**
 * Exclusion filter: items whose allergens intersect `selected` are HIDDEN.
 * Empty selection → everything visible (all items pass through).
 */
export function filterByAllergens<T>(items: T[], allergensOf: (item: T) => unknown, selected: string[]): T[] {
  if (!Array.isArray(selected) || selected.length === 0) return items
  const sel = new Set(selected.map((s) => s.trim().toLowerCase()).filter(Boolean))
  if (sel.size === 0) return items
  return items.filter((it) => {
    const labels = parseAllergens(allergensOf(it))
    return !labels.some((l) => sel.has(l.toLowerCase()))
  })
}
