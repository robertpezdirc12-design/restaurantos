'use client'

import { useEffect, useMemo, type ComponentType } from 'react'
import {
  CommandDialog, CommandInput, CommandList, CommandEmpty,
  CommandGroup, CommandItem, CommandSeparator,
} from '@/components/ui/command'
import {
  RefreshCw, Plus, LogOut, Search, ShieldCheck, CircleDot,
} from 'lucide-react'
import { tabHasPerm, type TabPermContext } from '@/lib/tab-permissions'
import { useI18n } from '@/components/i18n'

/**
 * COMMAND PALETTE (R268) — kanonska avtorizacija akcij:
 *  - Navigacija: vsi zavihki
 *  - Akcije: odvisne od vloge (ADMIN/MANAGER ↔ WAITER/KITCHEN)
 *  - Občutljive akcije so označene in gredo skozi SENSITIVE ACTION potrditev (R266)
 *
 * QA-val #10 (P3): navigacija je zdaj IZPELJANA iz istega vira kot stranski
 * steber — `tabs` (DASHBOARD_TABS) + `ctx` (tabHasPerm), ne ločen ročen seznam.
 * Prej je paleta obljubljala »vsi zavihki«, a jih je imela 15/32: Napitnine,
 * Nabava, Prenosi, Odpad, Popusti, Darilne kartice, Analiza menija, Dostava,
 * Čakalna lista, Hitra prodaja, Odnosi z gosti, Obračun, Delovni čas, Razpored,
 * Odprtost, Integracije in Organizacija so bili z Ctrl+K NEDOSEGLJIVI.
 * Dovoljenja zdaj tečejo skozi tabHasPerm (isti kanon kot sidebar — issue #72
 * A4 namen ohranjen in okrepšen: NI več podvojene logike vlog v paleti),
 * oznake pa iz t(`tabs.${id}`) — SL/HR pošteno, enaka imena kot v navigaciji.
 */
interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** isti vir kot DashboardSidebar: DASHBOARD_TABS (id + ikona) */
  tabs: [string, ComponentType<{ className?: string }> | null][]
  /** isti konteksto kot DashboardSidebar: { canManage, perms } → tabHasPerm */
  ctx: TabPermContext
  onNavigate: (tab: string) => void
  onRefresh: () => void
  onNewOrder: () => void
  onLogout: () => void
}

export function CommandPalette({ open, onOpenChange, tabs, ctx, onNavigate, onRefresh, onNewOrder, onLogout }: Props) {
  const { t } = useI18n()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  const run = (fn: () => void) => { onOpenChange(false); fn() }

  const visible = useMemo(() => tabs.filter(([v]) => tabHasPerm(v, ctx)), [tabs, ctx])

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Išči ukaz… (navigacija, akcije)" />
      <CommandList>
        <CommandEmpty>Ni zadetkov.</CommandEmpty>
        <CommandGroup heading="Navigacija">
          {visible.map(([v, Icon]) => (
            <CommandItem key={v} value={`${t(`tabs.${v}`)} ${v}`} onSelect={() => run(() => onNavigate(v))}>
              {Icon ? <Icon className="w-4 h-4" /> : <CircleDot className="w-4 h-4" />} {t(`tabs.${v}`)}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Akcije">
          <CommandItem onSelect={() => run(onRefresh)}>
            <RefreshCw className="w-4 h-4" /> Osveži podatke
          </CommandItem>
          <CommandItem onSelect={() => run(onNewOrder)}>
            <Plus className="w-4 h-4" /> Novo naročilo (mize)
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Sistem">
          <CommandItem onSelect={() => run(onLogout)}>
            <LogOut className="w-4 h-4" /> Odjava <span className="ml-auto text-xs text-stone-400">občutljivo</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

/** Gumb v headerju za odpiranje palete (viden tudi na dotik) */
export function PaletteButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="hidden sm:flex items-center gap-1.5 rounded-md border border-stone-200 bg-stone-50 px-2.5 h-9 text-xs text-stone-500 hover:bg-stone-100 transition"
      aria-label="Odpri ukazno paleto"
    >
      <Search className="w-3.5 h-3.5" /> Ukazi
      <kbd className="ml-1 rounded-sm border border-stone-300 bg-white px-1 text-xs font-semibold">Ctrl K</kbd>
    </button>
  )
}

export function PaletteHint() {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-stone-400">
      <ShieldCheck className="w-3.5 h-3.5" /> akcije po vlogi
    </span>
  )
}
