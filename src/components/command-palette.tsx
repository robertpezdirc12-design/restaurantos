'use client'

import { useEffect } from 'react'
import {
  CommandDialog, CommandInput, CommandList, CommandEmpty,
  CommandGroup, CommandItem, CommandSeparator,
} from '@/components/ui/command'
import {
  LayoutDashboard, Utensils, ClipboardList, ChefHat, BookOpen, CalendarDays,
  ReceiptText, Users, Settings, RefreshCw, Plus, LogOut, Search, ShieldCheck,
  PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, Star,
} from 'lucide-react'

/**
 * COMMAND PALETTE (R268) — kanonska avtorizacija akcij:
 *  - Navigacija: vsi zavihki
 *  - Akcije: odvisne od vloge (ADMIN/MANAGER ↔ WAITER/KITCHEN)
 *  - Občutljive akcije so označene in gredo skozi SENSITIVE ACTION potrditev (R266)
 */
export interface PaletteUser { id: string; name: string; role: string }

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  user: PaletteUser | null
  onNavigate: (tab: string) => void
  onRefresh: () => void
  onNewOrder: () => void
  onLogout: () => void
}

const canManage = (role?: string) => role === 'ADMIN' || role === 'MANAGER'

export function CommandPalette({ open, onOpenChange, user, onNavigate, onRefresh, onNewOrder, onLogout }: Props) {
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

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Išči ukaz… (navigacija, akcije)" />
      <CommandList>
        <CommandEmpty>Ni zadetkov.</CommandEmpty>
        <CommandGroup heading="Navigacija">
          <CommandItem onSelect={() => run(() => onNavigate('pregled'))}>
            <LayoutDashboard className="w-4 h-4" /> Pregled
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate('mize'))}>
            <Utensils className="w-4 h-4" /> Mize
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate('narocila'))}>
            <ClipboardList className="w-4 h-4" /> Naročila
          </CommandItem>
          {canManage(user?.role) || user?.role === 'KITCHEN' ? (
            <CommandItem onSelect={() => run(() => onNavigate('kuhinja'))}>
              <ChefHat className="w-4 h-4" /> Kuhinja
            </CommandItem>
          ) : null}
          <CommandItem onSelect={() => run(() => onNavigate('meni'))}>
            <BookOpen className="w-4 h-4" /> Meni
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate('rezervacije'))}>
            <CalendarDays className="w-4 h-4" /> Rezervacije
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate('racuni'))}>
            <ReceiptText className="w-4 h-4" /> Računi (FURS)
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate('zaloge'))}>
            <PackageSearch className="w-4 h-4" /> Zaloge
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate('izmene'))}>
            <Clock className="w-4 h-4" /> Izmene + Z-poročila
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate('haccp'))}>
            <Thermometer className="w-4 h-4" /> HACCP kontrole
          </CommandItem>
          {canManage(user?.role) ? (
            <CommandItem onSelect={() => run(() => onNavigate('stroski'))}>
              <Wallet className="w-4 h-4" /> Stroški
            </CommandItem>
          ) : null}
          {canManage(user?.role) ? (
            <CommandItem onSelect={() => run(() => onNavigate('zvestoba'))}>
              <HeartHandshake className="w-4 h-4" /> Zvestoba
            </CommandItem>
          ) : null}
          <CommandItem onSelect={() => run(() => onNavigate('mnenja'))}>
            <Star className="w-4 h-4" /> Mnenja gostov
          </CommandItem>
          {canManage(user?.role) ? (
            <CommandItem onSelect={() => run(() => onNavigate('zaposleni'))}>
              <Users className="w-4 h-4" /> Zaposleni
            </CommandItem>
          ) : null}
          {canManage(user?.role) ? (
            <CommandItem onSelect={() => run(() => onNavigate('nastavitve'))}>
              <Settings className="w-4 h-4" /> Nastavitve
            </CommandItem>
          ) : null}
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
      <kbd className="ml-1 rounded border border-stone-300 bg-white px-1 text-[10px] font-semibold">Ctrl K</kbd>
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
