/**
 * Tipovni sloj za Prisma enume — odporen na sqlite/prod razliko generiranega clienta.
 *
 * Kontekst (issue #10 vzdrževalna popravka): lokalni dev generira client iz
 * prisma/schema.sqlite.prisma (SQLite ne podpira enum blokov — vrednosti so String),
 * produkcijski/CI client pa iz prisma/schema.prisma (Postgres, 20 enumov). Rute, ki
 * uvozijo enum tipe iz '@prisma/client', so s sqlite clientom zatajile na tsc.
 *
 * Rešitev: kanonične string-union tipe definira TA modul (vrednosti identične
 * enum blokom v schema.prisma) in vse rabe gredo čeznjega. To so isključno
 * TIP-OVSKI uvoz — casti ostajajo string→string, runtime vedenje je nespremenjeno
 * (§18). Z prod clientom union ničesar ne zlomi (isti literali, širša poteza).
 */

export type EmployeeRole = 'owner' | 'admin' | 'manager' | 'staff' | 'waiter' | 'bar' | 'chef' | 'kitchen'

export type HaccpCategory = 'temperature' | 'cleaning' | 'delivery' | 'cooling' | 'training'

export type HaccpStatus = 'ok' | 'warning' | 'critical' | 'archived'

export type OrderItemStatus = 'pending' | 'fired' | 'preparing' | 'ready' | 'served' | 'cancelled' | 'voided'

export type ReservationSource = 'walk_in' | 'phone' | 'website' | 'app'

export type ReservationStatus = 'confirmed' | 'seated' | 'completed' | 'cancelled' | 'no_show'

export type TableStatus = 'available' | 'occupied' | 'reserved' | 'cleaning'
