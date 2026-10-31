'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Plus, Tag, Trash2, Link2, Pencil } from 'lucide-react'
import { isVariantGroup } from '@/lib/item-variants'

/**
 * OSS-10 (v1.209.0) — VARIANTE ARTIKLOV: admin kartica »Skupine opcij (variante)«.
 *
 * Prvi admin UI/API za skupine opcij sploh (prej so skupine obstajale le v testnih
 * fiksturah). Predloga »varianta« (velikost/nivo) = obvezna skupina z NATANČNO
 * eno izbiro (required=true, minSelect=1, maxSelect=1) — isti kontrakt, ki ga
 * strežnik že uveljavlja pri naročanju (src/lib/modifiers.ts) in kiosk/QR UI
 * že spoštuje. Razred skupine prihaja iz čistega sloja item-variants.ts
 * (isVariantGroup) — UI si ga NE izmišljuje, samo prikaže.
 *
 * Pripeto artiklov pokaže števec; dialog »Pripni na artikle« ima predizbor po
 * linkedMenuItemIds iz GET /api/modifier-groups; pripetost se takoj vidi v
 * gostovskih tokovih (kiosk/QR/mobilni že berejo skupine).
 */

interface ModifierT { id: string; name: string; price: number; isAvailable: boolean; sortOrder: number; allergens: string[] }
interface GroupT {
  id: string; name: string; required: boolean; minSelect: number
  maxSelect: number | null; sortOrder: number; variant: boolean; links: number
  linkedMenuItemIds: string[]; modifiers: ModifierT[]
}
interface MenuItemT { id: string; name: string; available?: boolean }

export function MenuModifiersCard({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [groups, setGroups] = useState<GroupT[] | null>(null)
  const [busy, setBusy] = useState(false)

  // dialog skupine (ustvari/uredi)
  const [dlgOpen, setDlgOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [gName, setGName] = useState('')
  const [gTemplate, setGTemplate] = useState<'free' | 'variant'>('free')
  const [gRequired, setGRequired] = useState(false)
  const [gMin, setGMin] = useState('0')
  const [gMax, setGMax] = useState('')

  // dialog pripetosti
  const [attGroup, setAttGroup] = useState<GroupT | null>(null)
  const [menuItems, setMenuItems] = useState<MenuItemT[]>([])
  const [attSet, setAttSet] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const res = await api<{ groups: GroupT[] }>('/api/modifier-groups')
      setGroups(res.groups)
    } catch (e) { toast({ title: (e as Error).message, variant: 'destructive' }) }
  }, [])

  useEffect(() => {
    void (async () => { await load() })()
  }, [load])

  function openCreate() {
    setEditId(null); setGName(''); setGTemplate('free'); setGRequired(false); setGMin('0'); setGMax('')
    setDlgOpen(true)
  }

  function openEdit(g: GroupT) {
    setEditId(g.id); setGName(g.name); setGTemplate(g.variant ? 'variant' : 'free')
    setGRequired(g.required); setGMin(String(g.minSelect)); setGMax(g.maxSelect === null ? '' : String(g.maxSelect))
    setDlgOpen(true)
  }

  function applyTemplate(v: 'free' | 'variant') {
    setGTemplate(v)
    // predloga variante = pametni privzeti (izrecni vnos ju lahko preglasi)
    if (v === 'variant') { setGRequired(true); setGMin('1'); setGMax('1') }
    else { setGRequired(false); setGMin('0'); setGMax('') }
  }

  async function saveGroup() {
    if (!gName.trim()) { toast({ title: t('modifiers.group.name'), variant: 'destructive' }); return }
    setBusy(true)
    try {
      if (editId) {
        await api(`/api/modifier-groups/${editId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: gName.trim(), required: gRequired, minSelect: Number(gMin), maxSelect: gMax.trim() === '' ? null : Number(gMax) }),
        })
      } else {
        await api('/api/modifier-groups', {
          method: 'POST',
          body: JSON.stringify({ name: gName.trim(), template: gTemplate, required: gRequired, minSelect: Number(gMin), maxSelect: gMax.trim() === '' ? null : Number(gMax) }),
        })
      }
      setDlgOpen(false)
      await load()
    } catch (e) { toast({ title: (e as Error).message, variant: 'destructive' }) } finally { setBusy(false) }
  }

  async function deleteGroup(g: GroupT) {
    if (!window.confirm(`${t('common.delete')}: ${g.name}?`)) return
    setBusy(true)
    try {
      await api(`/api/modifier-groups/${g.id}`, { method: 'DELETE' })
      await load()
    } catch (e) { toast({ title: (e as Error).message, variant: 'destructive' }) } finally { setBusy(false) }
  }

  async function addOption(g: GroupT, name: string, price: string) {
    if (!name.trim()) return
    setBusy(true)
    try {
      await api('/api/modifiers', {
        method: 'POST',
        body: JSON.stringify({ modifierGroupId: g.id, name: name.trim(), price: price.trim() === '' ? 0 : price.trim() }),
      })
      await load()
    } catch (e) { toast({ title: (e as Error).message, variant: 'destructive' }) } finally { setBusy(false) }
  }

  async function toggleOption(m: ModifierT) {
    setBusy(true)
    try {
      await api(`/api/modifiers/${m.id}`, { method: 'PATCH', body: JSON.stringify({ isAvailable: !m.isAvailable }) })
      await load()
    } catch (e) { toast({ title: (e as Error).message, variant: 'destructive' }) } finally { setBusy(false) }
  }

  async function deleteOption(m: ModifierT) {
    if (!window.confirm(`${t('common.delete')}: ${m.name}?`)) return
    setBusy(true)
    try {
      await api(`/api/modifiers/${m.id}`, { method: 'DELETE' })
      await load()
    } catch (e) { toast({ title: (e as Error).message, variant: 'destructive' }) } finally { setBusy(false) }
  }

  async function openAttach(g: GroupT) {
    setAttGroup(g); setAttSet(new Set(g.linkedMenuItemIds)); setMenuItems([])
    try {
      const res = await api<{ items: MenuItemT[] }>('/api/menus')
      setMenuItems(res.items ?? [])
    } catch (e) { toast({ title: (e as Error).message, variant: 'destructive' }) }
  }

  async function toggleAttach(g: GroupT, menuItemId: string, checked: boolean) {
    setBusy(true)
    try {
      const res = await api<{ attached: boolean; links: number }>(`/api/modifier-groups/${g.id}/menu-items`, {
        method: 'POST',
        body: JSON.stringify({ menuItemId, action: checked ? 'attach' : 'detach' }),
      })
      setAttSet((prev) => { const n = new Set(prev); if (checked) n.add(menuItemId); else n.delete(menuItemId); return n })
      setAttGroup((prev) => (prev ? { ...prev, links: res.links } : prev))
    } catch (e) { toast({ title: (e as Error).message, variant: 'destructive' }) } finally { setBusy(false) }
  }

  return (
    <Card data-region="menu-modifiers">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base"><Tag className="h-4 w-4" /> {t('modifiers.card.title')}</CardTitle>
          {canManage && (
            <Button size="sm" className="h-11 sm:h-8" onClick={openCreate} disabled={busy}>
              <Plus className="mr-1 h-4 w-4" /> {t('modifiers.group.new')}
            </Button>
          )}
        </div>
        <p className="text-sm text-stone-500">{t('modifiers.card.desc')}</p>
      </CardHeader>
      <CardContent>
        {groups === null ? (
          <div className="flex items-center gap-2 py-4 text-stone-500"><Loader2 className="h-4 w-4 animate-spin" /> …</div>
        ) : groups.length === 0 ? (
          <p className="py-2 text-sm text-stone-500">{t('common.none')}</p>
        ) : (
          <div className="max-h-96 space-y-3 overflow-y-auto pr-1 os-scrollbar">
            {groups.map((g) => (
              <div key={g.id} className="rounded-lg border border-stone-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <p className="font-medium truncate">{g.name}</p>
                    {g.variant && <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800">{t('modifiers.variant.badge')}</Badge>}
                    {!g.variant && g.required && <Badge className="border-amber-200 bg-amber-50 text-amber-800">{t('modifiers.group.required')}</Badge>}
                    <span className="text-xs text-stone-500">{t('modifiers.links.count', { n: g.links })}</span>
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" variant="outline" className="h-11 sm:h-7 px-2 text-xs" onClick={() => void openAttach(g)}><Link2 className="mr-1 h-3.5 w-3.5" />{t('modifiers.items.attach')}</Button>
                      <Button size="sm" variant="outline" className="h-11 sm:h-7 px-2 text-xs" onClick={() => openEdit(g)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button size="sm" variant="outline" className="h-11 sm:h-7 px-2 text-xs text-red-700 hover:text-red-800" onClick={() => void deleteGroup(g)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  )}
                </div>
                <div className="mt-2 space-y-1">
                  {g.modifiers.length === 0 && <p className="text-xs text-stone-400">{t('common.none')}</p>}
                  {g.modifiers.map((m) => (
                    <div key={m.id} className="flex items-center justify-between gap-2 rounded border border-stone-100 bg-stone-50 px-2 py-1">
                      <span className={`min-w-0 truncate text-sm ${m.isAvailable ? '' : 'text-stone-400 line-through'}`}>{m.name}</span>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-xs tabular-nums text-stone-500">{m.price > 0 ? `+${m.price.toFixed(2)} EUR` : '0.00 EUR'}</span>
                        {canManage && (
                          <>
                            <Button size="sm" variant={m.isAvailable ? 'outline' : 'secondary'} className="h-7 px-2 text-xs" onClick={() => void toggleOption(m)}>{m.isAvailable ? t('menu.inStock') : t('menu.outOfStock')}</Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-red-700 hover:text-red-800" onClick={() => void deleteOption(m)}><Trash2 className="h-3.5 w-3.5" /></Button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                  {canManage && <OptionAddRow busy={busy} onAdd={(name, price) => void addOption(g, name, price)} t={t} />}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* dialog: ustvari / uredi skupino */}
      <Dialog open={dlgOpen} onOpenChange={setDlgOpen}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{editId ? `${t('common.edit')} — ${gName}` : t('modifiers.group.new')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="mod-group-name">{t('modifiers.group.name')}</Label>
              <Input id="mod-group-name" value={gName} onChange={(e) => setGName(e.target.value)} maxLength={120} className="h-11" />
            </div>
            {!editId && (
              <div className="space-y-1">
                <Label>{t('modifiers.group.template')}</Label>
                <Select value={gTemplate} onValueChange={(v) => applyTemplate(v as 'free' | 'variant')}>
                  <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="free">{t('modifiers.template.free')}</SelectItem>
                    <SelectItem value="variant">{t('modifiers.template.variant')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div className="flex items-center gap-2 pt-5">
                <Checkbox id="mod-group-required" checked={gRequired} onCheckedChange={(v) => setGRequired(v === true)} />
                <Label htmlFor="mod-group-required" className="text-xs">{t('modifiers.group.required')}</Label>
              </div>
              <div className="space-y-1">
                <Label htmlFor="mod-group-min" className="text-xs">{t('modifiers.group.min')}</Label>
                <Input id="mod-group-min" type="number" min={0} max={50} value={gMin} onChange={(e) => setGMin(e.target.value)} className="h-11" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mod-group-max" className="text-xs">{t('modifiers.group.max')}</Label>
                <Input id="mod-group-max" type="number" min={1} max={50} value={gMax} onChange={(e) => setGMax(e.target.value)} className="h-11" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" className="h-11" onClick={() => setDlgOpen(false)}>{t('common.cancel')}</Button>
              <Button className="h-11" onClick={() => void saveGroup()} disabled={busy}>
                {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}{t('common.save')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* dialog: pripni/odpni artikle */}
      <Dialog open={attGroup !== null} onOpenChange={(o) => { if (!o) setAttGroup(null) }}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('modifiers.items.attach')} — {attGroup?.name}</DialogTitle>
          </DialogHeader>
          <div className="max-h-96 space-y-1 overflow-y-auto os-scrollbar">
            {menuItems.length === 0 && <p className="text-sm text-stone-500">{t('common.none')}</p>}
            {menuItems.map((mi) => (
              <label key={mi.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-stone-50">
                <Checkbox
                  checked={attSet.has(mi.id)}
                  onCheckedChange={(v) => { if (attGroup) void toggleAttach(attGroup, mi.id, v === true) }}
                  disabled={busy}
                />
                <span className="text-sm truncate">{mi.name}</span>
              </label>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** Vrstica za dodajanje opcije v skupino (ime + doplačilo, cena pošteno 0 = brez). */
function OptionAddRow({ busy, onAdd, t }: { busy: boolean; onAdd: (name: string, price: string) => void; t: (key: string) => string }) {
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  return (
    <div className="mt-2 flex gap-1.5">
      <Input
        aria-label={t('modifiers.option.name')}
        placeholder={t('modifiers.option.name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-11 sm:h-8 text-sm"
        maxLength={120}
      />
      <Input
        aria-label={t('modifiers.option.price')}
        placeholder={t('modifiers.option.price')}
        value={price}
        inputMode="decimal"
        onChange={(e) => setPrice(e.target.value)}
        className="h-11 sm:h-8 w-28 text-sm"
      />
      <Button
        size="sm"
        variant="outline"
        className="h-11 sm:h-8 shrink-0"
        disabled={busy || !name.trim()}
        onClick={() => { onAdd(name, price); setName(''); setPrice('') }}
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  )
}
