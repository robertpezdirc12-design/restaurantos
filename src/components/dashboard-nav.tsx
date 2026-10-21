'use client'

/* ─────────────────────────────────────────────────────────────────────────────
 * Issue #73 (v1.138.0) — audit-10: navigacijski steber + mobilna vrstica.
 *
 * TRI površine, EN izvorna resnica:
 *  1. DashboardSidebar (≥ lg): levi steber s skupinami (Naročanje · Gostje ·
 *     Zaloge in finance · Ekipa · Sistem) + iskalnik zavihkov — uporabnik vidi,
 *     kaj aplikacija ZNA (prej: 27 zavihkov skritih v gumbu ⋮ brez oznake).
 *  2. MobileBottomNav (< lg): spodnja vrstica s 4–5 zavihki DEJANSKE vloge
 *     uporabnika + gumb »Več« (predal s celotnim drevesom).
 *  3. MobileNavDrawer (< lg): predal s skupinami + iskalnik (isti drevesni
 *     upodobitveni deležnik kot steber).
 *
 * audit-11: enoten besednjak — komponenta NE izumlja imen: vsi naslovi
 * zavihkov/skupin so t(`tabs.${id}`) / t(NAV_GROUP_LABEL_KEY) iz slovarjev.
 * Navigacija je semantično <nav> z gumbi in aria-current (APG navigacijski
 * vzorec, ne tablist): 32 postavk v eni vrstici tablist bi prelomilo tipko Tab
 * — skip-to-content povezava v page.tsx že pokriva preskok.
 * ──────────────────────────────────────────────────────────────────────────── */

import { useMemo, useState, type ComponentType } from 'react'
import { MoreHorizontal, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { useI18n } from '@/components/i18n'
import {
  NAV_GROUP_KEYS, NAV_GROUP_LABEL_KEY, NAV_STANDALONE_TABS, mobileTabsForRole, navGroupOf, normNavText,
} from '@/lib/nav-groups'
import { tabHasPerm } from '@/lib/tab-permissions'

export type NavTabT = [string, ComponentType<{ className?: string }> | null]

interface NavCtxT {
  canManage: boolean
  perms: string[]
}

export interface NavCommonProps {
  /** DASHBOARD_TABS iz page.tsx ([id, ikona]) — en vir ikon */
  tabs: NavTabT[]
  activeTab: string
  onSelect: (tab: string) => void
  ctx: NavCtxT
}

/* En gumb navigacijske postavke (steber + predal delita deležnik). */
function NavItem({
  id, Icon, label, groupLabel, active, onSelect, showGroup,
}: {
  id: string
  Icon: ComponentType<{ className?: string }> | null
  label: string
  groupLabel?: string
  active: boolean
  onSelect: (tab: string) => void
  showGroup?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-current={active ? 'page' : undefined}
      title={showGroup && groupLabel ? `${label} — ${groupLabel}` : label}
      className={`flex w-full items-center gap-2.5 rounded-lg border-l-2 py-2 pl-2.5 pr-2 text-left text-sm transition ${
        active
          ? 'border-emerald-400 bg-sidebar-accent font-semibold text-sidebar-accent-foreground'
          : 'border-transparent font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
      }`}
    >
      {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {showGroup && groupLabel && <span className="hidden text-[11px] font-normal text-stone-400 xl:inline">{groupLabel}</span>}
    </button>
  )
}

/* Iskalnik zavihkov (steber + predal delita deležnik). */
function NavSearch({
  value, onChange, label, placeholder, region,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  placeholder: string
  region: string
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" aria-hidden="true" />
      <Input
        data-region={region}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-9 pl-8 text-sm"
      />
    </div>
  )
}

/**
 * Skupinsko drevo zavihkov (skupni deležnik stebra in predala).
 * Prazna poizvedba → skupine + samostojni »Pregled«; neprazna → raven seznam
 * zadetkov z oznako skupine (iskanje čez vse razdelke).
 */
function NavTree({
  visible, query, activeTab, onSelect, t, listRegion,
}: {
  visible: NavTabT[]
  query: string
  activeTab: string
  onSelect: (tab: string) => void
  t: (key: string, vars?: Record<string, string | number>) => string
  listRegion?: string
}) {
  const norm = normNavText(query)
  const matched = useMemo(() => {
    if (!norm) return null
    return visible.filter(([v]) => normNavText(t(`tabs.${v}`)).includes(norm) || normNavText(v).includes(norm))
  }, [visible, norm, t])

  if (matched) {
    return (
      <div data-region={listRegion} data-nav-mode="search" className="space-y-0.5">
        {matched.length === 0 && <p className="px-2.5 py-3 text-sm text-stone-500">{t('nav.noResults')}</p>}
        {matched.map(([v, Icon]) => (
          <NavItem
            key={v}
            id={v}
            Icon={Icon}
            label={t(`tabs.${v}`)}
            groupLabel={t(NAV_GROUP_LABEL_KEY[navGroupOf(v)])}
            showGroup
            active={activeTab === v}
            onSelect={onSelect}
          />
        ))}
      </div>
    )
  }

  return (
    <div data-region={listRegion} data-nav-mode="groups" className="space-y-4">
      {/* Domov — nad skupinami (Pregled ni del naročanja) */}
      {NAV_GROUP_KEYS.length > 0 && visible
        .filter(([v]) => (NAV_STANDALONE_TABS as readonly string[]).includes(v))
        .map(([v, Icon]) => (
          <NavItem key={v} id={v} Icon={Icon} label={t(`tabs.${v}`)} active={activeTab === v} onSelect={onSelect} />
        ))}
      {NAV_GROUP_KEYS.map((g) => {
        const groupTabs = visible.filter(
          ([v]) => navGroupOf(v) === g && !(NAV_STANDALONE_TABS as readonly string[]).includes(v),
        )
        if (groupTabs.length === 0) return null
        return (
          <div key={g} data-nav-group={g}>
            <p className="px-2.5 pb-1 pt-1 text-[11px] font-bold uppercase tracking-wider text-stone-400">
              {t(NAV_GROUP_LABEL_KEY[g])}
            </p>
            <div className="space-y-0.5">
              {groupTabs.map(([v, Icon]) => (
                <NavItem key={v} id={v} Icon={Icon} label={t(`tabs.${v}`)} active={activeTab === v} onSelect={onSelect} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── 1 · STRANSKI STEBER (≥ lg) ──────────────────────────────────────────── */

export function DashboardSidebar({ tabs, activeTab, onSelect, ctx }: NavCommonProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const visible = useMemo(
    () => tabs.filter(([v]) => tabHasPerm(v, ctx)),
    [tabs, ctx],
  )

  return (
    <aside data-region="dashboard-sidebar" className="hidden w-64 shrink-0 lg:block">
      <div className="sticky top-14 flex h-[calc(100vh-3.5rem)] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="border-b border-sidebar-border p-3">
          <NavSearch
            value={query}
            onChange={setQuery}
            label={t('nav.searchLabel')}
            placeholder={t('nav.searchPlaceholder')}
            region="nav-search"
          />
        </div>
        <nav aria-label={t('nav.mainAria')} className="flex-1 overflow-y-auto px-2 py-3">
          <NavTree visible={visible} query={query} activeTab={activeTab} onSelect={onSelect} t={t} listRegion="nav-sidebar-tree" />
        </nav>
      </div>
    </aside>
  )
}

/* ── 2 · MOBILNA SPODNA VRSTICA (< lg) ───────────────────────────────────── */

export function MobileBottomNav({
  tabs, activeTab, onSelect, ctx, role, onOpenMore,
}: NavCommonProps & { role?: string | null; onOpenMore: () => void }) {
  const { t } = useI18n()
  const barTabs = useMemo(() => {
    const roleSet = mobileTabsForRole(role, ctx)
    return tabs.filter(([v]) => roleSet.includes(v) || v === activeTab)
  }, [tabs, role, ctx, activeTab])

  return (
    <nav
      data-region="dashboard-mobile-nav"
      aria-label={t('nav.quickAria')}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-sidebar-border bg-sidebar text-sidebar-foreground pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <div className="mx-auto flex max-w-lg items-stretch">
        {barTabs.map(([v, Icon]) => {
          const active = activeTab === v
          return (
            <button
              key={v}
              type="button"
              onClick={() => onSelect(v)}
              aria-current={active ? 'page' : undefined}
              aria-label={t(`tabs.${v}`)}
              className={`relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition ${
                active ? 'text-emerald-300' : 'text-sidebar-foreground/60 hover:text-sidebar-foreground'
              }`}
            >
              {active && <span className="absolute inset-x-2 top-0 h-0.5 rounded-b bg-emerald-400" aria-hidden="true" />}
              {Icon && <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />}
              <span className="max-w-full truncate px-0.5">
                {v === 'prodaja' ? t('tabs.prodajaShort') : t(`tabs.${v}`)}
              </span>
            </button>
          )
        })}
        <button
          type="button"
          onClick={onOpenMore}
          aria-haspopup="dialog"
          aria-label={t('nav.moreAria')}
          className="flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-sidebar-foreground/60 transition hover:text-sidebar-foreground"
        >
          <MoreHorizontal className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="max-w-full truncate px-0.5">{t('tabs.more')}</span>
        </button>
      </div>
    </nav>
  )
}

/* ── 3 · PREDAL »VEČ« (< lg) — celotno drevo + iskalnik ───────────────────── */

export function MobileNavDrawer({
  open, onOpenChange, tabs, activeTab, onSelect, ctx,
}: NavCommonProps & { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const visible = useMemo(
    () => tabs.filter(([v]) => tabHasPerm(v, ctx)),
    [tabs, ctx],
  )
  const select = (v: string) => {
    onSelect(v)
    onOpenChange(false)
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent data-region="nav-drawer" className="max-h-[82vh] bg-sidebar text-sidebar-foreground">
        <DrawerHeader className="pb-2">
          <DrawerTitle className="text-left text-base">{t('nav.drawerTitle')}</DrawerTitle>
          <DrawerDescription className="sr-only">{t('nav.drawerDesc')}</DrawerDescription>
        </DrawerHeader>
        <div className="px-4 pb-2">
          <NavSearch
            value={query}
            onChange={setQuery}
            label={t('nav.searchLabel')}
            placeholder={t('nav.searchPlaceholder')}
            region="nav-search-drawer"
          />
        </div>
        <div className="max-h-[58vh] overflow-y-auto px-4 pb-6">
          <NavTree visible={visible} query={query} activeTab={activeTab} onSelect={select} t={t} listRegion="nav-drawer-tree" />
        </div>
      </DrawerContent>
    </Drawer>
  )
}
