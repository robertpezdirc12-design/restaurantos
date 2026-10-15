'use client'

/* ─────────────────────── RAZREZ MONOLITA (v1.82.1 → v1.82.7, 7+1 valov) — ZAKLJUČENO ───────────────────────
 * dashboard-tabs.tsx 9217 → 43 vrst. (−99,5 %): izvorni monolit je razrezan v 12 domenskih
 * datotek src/components/tabs/ (vsaka ~200–1400 vrst.). Ta modul je od vala 7 NAPREJ ČISTI
 * BARREL — nič lastne komponentne logike več, samo re-exporti. Vsi obstoječi uvozi
 * (@/components/dashboard-tabs, edini potrošnik: src/app/dashboard/page.tsx) delujejo
 * nespremenjeno. Vsi premiki so bili byte-identični (python diff dokazi v commitih).
 *
 * Zgodovina valov:
 *   v1.82.1 val 1: ops-cards + nabava-tab · v1.82.2 val 2: furs issue.ts (lib)
 *   v1.82.3 val 3: gostinske-ops + urniki + integracje · v1.82.4 val 4: backoffice
 *   v1.82.5 val 5: zaloga + finance + haccp · v1.82.6 val 6: gostje + nastavitve + enterprise
 *   v1.82.7 val 7: urnik-izmen + analitika (ta commit) → monolit = čisti barrel
 */

export {
  SalesByHourCard, LaborCostCard, DursCheckButton, NotificationsCard,
  BatchesCard, BatchPrepCard, UpsellCard, DisplayPromosCard,
} from './tabs/ops-cards'
export { NabavaTab } from './tabs/nabava-tab'
export { DarilneKarticeTab, OdpadTab, CakalnaListaTab } from './tabs/gostinske-ops-tab'
export { DelovniCasTab, OdpiralniCasTab, DiscountsTab } from './tabs/urniki-tab'
export type { OpeningHoursRowT, DiscountRowT, TimeEntryT, TimeclockEmployeeT } from './tabs/urniki-tab'
export { IntegracijeTab } from './tabs/integracje-tab'
export { DeliveryTab, AccountingExportCard, GlJournalCard, NapitnineTab } from './tabs/backoffice-tab'
export type { DeliveryInfoT, DeliveryOrderT, DeliveryZoneT, PlatformIntegrationT } from './tabs/backoffice-tab'
export { InventoryTab } from './tabs/zaloga-tab'
export type { InventoryT, SupplierT, RecipeT, RecipeLineT } from './tabs/zaloga-tab'
export { ShiftsTab, ExpensesTab } from './tabs/finance-tab'
export type { ShiftT, FinancialT, ExpenseT } from './tabs/finance-tab'
export { HaccpTab } from './tabs/haccp-tab'
export type { HaccpT, HaccpPlanT } from './tabs/haccp-tab'
export { LoyaltyTab, FeedbackTab } from './tabs/gostje-tab'
export type { LoyaltyT, FeedbackT } from './tabs/gostje-tab'
export { JobsCard, SettingsEditor, DevicesCard, MfaCard } from './tabs/nastavitve-tab'
export type { JobT, SettingsT, DeviceT } from './tabs/nastavitve-tab'
export { ReservationWidgetCard } from './tabs/reservation-widget-card'
/* Issue #21 (v1.111.0) — klic vodje iz POS-a: plošča vodje + nastavitve */
export { ManagerCallsCard } from './tabs/manager-calls-card'
export { ManagerCallSettingsCard } from './tabs/manager-call-settings-card'
export { EnterpriseTab, MigrationsConsoleSection } from './tabs/enterprise-tab'
export { StaffScheduleTab } from './tabs/urnik-izmen-tab'
export type { StaffShiftRowT, TimeOffRowT } from './tabs/urnik-izmen-tab'
export { MenuEngineeringTab, KdsStatsSection, FoodCostVarianceCard } from './tabs/analitika-tab'
export { ExceptionsReportCard } from './tabs/exceptions-card'
