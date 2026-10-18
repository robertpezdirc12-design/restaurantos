'use client'

/**
 * Issue #7 (P1, v1.104.0) — AlergenDialog: upravljanje alergenskega profila jedi.
 *
 * Vir podatkov: GET /api/menus/[id]/allergens (izračun iz sestavin recepture,
 * legacy zapisa in ročnega popravka). Akcije:
 *  - Potrdi profil (menu.manage) — izjava odgovorne osebe o skladnosti;
 *  - Ročni popravek (menu.manage) — dodaj/odstrani + RAZLOG ≥ 10 (izvor+kdo+kdaj
 *    v audit sledi; odstranjene kode OSTANEJO vidne);
 *  - Urejanje sestavin (inventory.manage) — strukturirane kode + "lahko vsebuje"
 *    (navzkrižna kontaminacija = ocena osebja, nikoli samodejna) + potrditev.
 *
 * Nikoli ne obljubi "varno za alergijo": needs_confirmation/review_required
 * prikažeta opozorilo (koda ni dokaz skladnosti — potrditev je poslovna izjava).
 */
import { useCallback, useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useI18n } from '@/components/i18n'
import { api } from '@/lib/client'
import { ALLERGEN_CODES, ALLERGEN_LABELS, type AllergenCode, type AllergenLocale } from '@/lib/allergen-catalog'

export interface AllergenProfileIngredientT {
  id: string
  name: string
  codes: string[]
  crossContact: string[]
  confirmedAt: string | null
  supplier: string
}

export interface AllergenProfileT {
  menuItemId: string
  menuItemName: string
  status: 'confirmed' | 'review_required' | 'needs_confirmation'
  codes: string[]
  derivedCodes: string[]
  legacyCodes: string[]
  crossContact: string[]
  unknownLabels: string[]
  removedByOverride: string[]
  modifierCodes: string[]
  sources: Record<string, { ingredients: string[]; modifiers: string[] }>
  ingredients: AllergenProfileIngredientT[]
  hasRecipe: boolean
  needsConfirmation: boolean
  unconfirmedIngredients: string[]
  confirmedAt: string | null
  confirmedByName: string | null
  reviewFlag: boolean
  reviewReason: string
  override: { add: string[]; remove: string[]; reason: string; confirmedByName: string | null; confirmedAt: string | null } | null
}

function statusBadgeClass(status: string): string {
  if (status === 'confirmed') return 'bg-emerald-100 text-emerald-800 border-emerald-300'
  if (status === 'review_required') return 'bg-amber-100 text-amber-800 border-amber-300'
  return 'bg-red-100 text-red-800 border-red-300'
}

export function AllergenDialog({
  itemId,
  itemName,
  canManageMenu,
  canManageInventory,
  onClose,
  onChanged,
}: {
  itemId: string | null
  itemName: string
  canManageMenu: boolean
  canManageInventory: boolean
  onClose: () => void
  onChanged?: () => void
}) {
  const { t, locale } = useI18n()
  const aloc: AllergenLocale = locale === 'hr' ? 'hr' : locale === 'en' ? 'en' : 'sl'
  const [profile, setProfile] = useState<AllergenProfileT | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [overrideAdd, setOverrideAdd] = useState<string[]>([])
  const [overrideRemove, setOverrideRemove] = useState<string[]>([])
  const [overrideReason, setOverrideReason] = useState('')
  const [editIngId, setEditIngId] = useState<string | null>(null)
  const [ingCodes, setIngCodes] = useState<string[]>([])
  const [ingCross, setIngCross] = useState<string[]>([])

  const load = useCallback(async () => {
    if (!itemId) return
    setLoading(true)
    setError('')
    try {
      const json = await api<{ profile: AllergenProfileT | null }>(`/api/menus/${itemId}/allergens`)
      const p = json?.profile ?? null
      setProfile(p)
      if (p?.override) {
        setOverrideAdd(p.override.add || [])
        setOverrideRemove(p.override.remove || [])
      } else {
        setOverrideAdd([])
        setOverrideRemove([])
      }
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setLoading(false)
    }
  }, [itemId])

  useEffect(() => {
    if (itemId) void load()
  }, [itemId, load])

  async function act(body: Record<string, unknown>) {
    if (!itemId) return
    setBusy(true)
    setNotice('')
    setError('')
    try {
      const json = await api<{ profile: AllergenProfileT | null }>(`/api/menus/${itemId}/allergens`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const p = json?.profile ?? null
      if (p) setProfile(p)
      setNotice(t('menu.allergenDialog.confirmInfo'))
      onChanged?.()
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  async function saveIngredient(ing: AllergenProfileIngredientT, confirm: boolean) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api('/api/inventory/allergens', {
        method: 'POST',
        body: JSON.stringify({
          inventoryItemId: ing.id,
          allergens: ingCodes,
          crossContact: ingCross,
          confirm,
        }),
      })
      setEditIngId(null)
      await load()
      onChanged?.()
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  const label = (code: string) => (ALLERGEN_CODES as readonly string[]).includes(code)
    ? ALLERGEN_LABELS[aloc][code as AllergenCode]
    : code

  const Chip = ({ code, onRemove }: { code: string; onRemove?: () => void }) => (
    <Badge variant="outline" className="gap-1 whitespace-normal">
      {label(code)}
      {onRemove && canManageMenu && (
        <button type="button" className="ml-1 text-stone-400 hover:text-red-600" onClick={onRemove} aria-label="odstrani">×</button>
      )}
    </Badge>
  )

  const CodeToggle = ({ code, active, onClick }: { code: string; active: boolean; onClick: () => void }) => (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active ? 'border-red-300 bg-red-50 text-red-800' : 'border-stone-300 bg-white text-stone-600 hover:border-stone-400'
      }`}
      aria-pressed={active}
    >
      {label(code)}
    </button>
  )

  return (
    <Dialog open={!!itemId} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('menu.allergenDialog.title', { name: itemName })}</DialogTitle>
        </DialogHeader>

        {loading && <p className="text-sm text-stone-500">…</p>}
        {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-sm px-3 py-2">{error}</p>}
        {notice && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-sm px-3 py-2">{notice}</p>}

        {profile && (
          <div className="space-y-4">
            {/* Stanje */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-stone-600">{t('menu.allergenDialog.status')}:</span>
              <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${statusBadgeClass(profile.status)}`}>
                {t(`menu.allergenStatus.${profile.status}`)}
              </span>
              {profile.reviewFlag && (
                <span className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-0.5">
                  {t('menu.allergenDialog.reviewFlag', { reason: profile.reviewReason })}
                </span>
              )}
              {profile.confirmedAt && profile.confirmedByName && (
                <span className="text-xs text-stone-500">
                  {t('menu.allergenDialog.confirmedBy', { name: profile.confirmedByName, date: new Date(profile.confirmedAt).toLocaleString(aloc === 'hr' ? 'hr-HR' : 'sl-SI') })}
                </span>
              )}
            </div>

            {/* Izračunani alergeni */}
            <section className="space-y-1.5">
              <p className="text-sm font-medium text-stone-600">{t('menu.allergenDialog.codes')}:</p>
              {profile.codes.length === 0 ? (
                <p className="text-sm text-stone-500">{t('menu.allergenDialog.none')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {profile.codes.map((c) => (
                    <Chip key={c} code={c} onRemove={canManageMenu ? () => setOverrideRemove((s) => (s.includes(c) ? s : [...s, c])) : undefined} />
                  ))}
                </div>
              )}
              {profile.crossContact.length > 0 && (
                <p className="text-xs text-amber-800">
                  ⚠ {t('menu.allergenDialog.crossContact')}: {profile.crossContact.map(label).join(', ')}
                </p>
              )}
              {profile.unknownLabels.length > 0 && (
                <p className="text-xs text-red-700">
                  ⚠ {t('menu.allergenDialog.unknownLabels')}: {profile.unknownLabels.join(', ')}
                </p>
              )}
              {profile.removedByOverride.length > 0 && (
                <p className="text-xs text-stone-500">
                  {t('menu.allergenDialog.removed')}: {profile.removedByOverride.map(label).join(', ')}
                </p>
              )}
              {profile.modifierCodes.length > 0 && (
                <p className="text-xs text-stone-500">
                  {t('menu.allergenDialog.ingCodes')} ({t('menu.allergenDialog.override')}): {profile.modifierCodes.map(label).join(', ')}
                </p>
              )}
              {Object.keys(profile.sources).length > 0 && (
                <details className="text-xs text-stone-500">
                  <summary className="cursor-pointer select-none">{t('menu.allergenDialog.sources')}</summary>
                  <ul className="mt-1 space-y-0.5 pl-3">
                    {Object.entries(profile.sources).map(([code, s]) => (
                      <li key={code}><b>{label(code)}:</b> {s.ingredients.join(', ')}{s.modifiers.length > 0 ? ` · ${s.modifiers.join(', ')}` : ''}</li>
                    ))}
                  </ul>
                </details>
              )}
            </section>

            {/* Sestavine */}
            <section className="space-y-1.5">
              <p className="text-sm font-medium text-stone-600">{t('menu.allergenDialog.ingredients')}:</p>
              {!profile.hasRecipe && <p className="text-xs text-amber-800">⚠ {t('menu.allergenDialog.notConfirmed')}</p>}
              <div className="max-h-56 overflow-y-auto rounded-lg border border-stone-200 divide-y divide-stone-100">
                {profile.ingredients.map((ing) => (
                  <div key={ing.id} className="p-2.5 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{ing.name}</p>
                        <p className="text-xs text-stone-500">
                          {ing.codes.length > 0 ? ing.codes.map(label).join(', ') : '—'}
                          {ing.crossContact.length > 0 && ` · ⚠ ${ing.crossContact.map(label).join(', ')}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {ing.confirmedAt ? (
                          <Badge variant="outline" className="text-emerald-700 border-emerald-300">✓</Badge>
                        ) : (
                          <Badge variant="outline" className="text-amber-700 border-amber-300">⚠</Badge>
                        )}
                        {canManageInventory && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              if (editIngId === ing.id) { setEditIngId(null); return }
                              setEditIngId(ing.id)
                              setIngCodes(ing.codes)
                              setIngCross(ing.crossContact)
                            }}
                          >
                            {editIngId === ing.id ? '×' : t('menu.allergenDialog.ingCodes')}
                          </Button>
                        )}
                      </div>
                    </div>
                    {editIngId === ing.id && (
                      <div className="space-y-2 rounded-md bg-stone-50 p-2">
                        <div className="flex flex-wrap gap-1.5">
                          {ALLERGEN_CODES.map((code) => (
                            <CodeToggle
                              key={code}
                              code={code}
                              active={ingCodes.includes(code)}
                              onClick={() => setIngCodes((s) => (s.includes(code) ? s.filter((x) => x !== code) : [...s, code]))}
                            />
                          ))}
                        </div>
                        <p className="text-xs text-stone-500">{t('menu.allergenDialog.ingCross')}:</p>
                        <div className="flex flex-wrap gap-1.5">
                          {ALLERGEN_CODES.map((code) => (
                            <CodeToggle
                              key={code}
                              code={code}
                              active={ingCross.includes(code)}
                              onClick={() => setIngCross((s) => (s.includes(code) ? s.filter((x) => x !== code) : [...s, code]))}
                            />
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void saveIngredient(ing, true)}>
                            {t('menu.allergenDialog.ingConfirm')}
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void saveIngredient(ing, false)}>
                            {t('menu.allergenDialog.overrideSave')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {!canManageInventory && <p className="text-xs text-stone-400">{t('menu.allergenDialog.ingNoPerm')}</p>}
            </section>

            {/* Ročni popravek */}
            {canManageMenu && (
              <section className="space-y-2 rounded-lg border border-stone-200 p-3">
                <p className="text-sm font-medium text-stone-600">{t('menu.allergenDialog.override')}</p>
                <div className="space-y-1">
                  <p className="text-xs text-stone-500">{t('menu.allergenDialog.overrideAdd')}:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {ALLERGEN_CODES.map((code) => (
                      <CodeToggle
                        key={code}
                        code={code}
                        active={overrideAdd.includes(code)}
                        onClick={() => setOverrideAdd((s) => (s.includes(code) ? s.filter((x) => x !== code) : [...s, code]))}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-stone-500">{t('menu.allergenDialog.overrideRemove')}:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {ALLERGEN_CODES.map((code) => (
                      <CodeToggle
                        key={code}
                        code={code}
                        active={overrideRemove.includes(code)}
                        onClick={() => setOverrideRemove((s) => (s.includes(code) ? s.filter((x) => x !== code) : [...s, code]))}
                      />
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="allergen-override-reason" className="text-xs">{t('menu.allergenDialog.overrideReason')}</Label>
                  <Input
                    id="allergen-override-reason"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    maxLength={300}
                  />
                </div>
                <Button
                  size="sm"
                  disabled={busy || overrideReason.trim().length < 10}
                  onClick={() => void act({ action: 'override', add: overrideAdd, remove: overrideRemove, reason: overrideReason })}
                >
                  {t('menu.allergenDialog.overrideSave')}
                </Button>
              </section>
            )}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            {profile && canManageMenu && (
              <Button size="sm" disabled={busy} onClick={() => void act({ action: 'confirm' })}>
                {t('menu.allergenDialog.confirm')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
              {t('menu.allergenDialog.refresh')}
            </Button>
          </div>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('menu.allergenDialog.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
