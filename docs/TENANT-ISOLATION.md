# Tenant Isolation (issue #12 §1 + §8)

## Meja

```
Tenant/Organization → Brand → Property → Location → (RevenueCenter/Workstation/Device/User)
```

**Location je operativno sidro** in pripada točno eni organizaciji prek verige
`Location.propertyId → Property.brandId → Brand.organizationId`.
Vsi transakcijski podatki (Order, Payment, Receipt, Device, …) nosijo `locationId`
→ eno lokacijo = eno organizacijo. Tenant meja se torej izračuna iz lokacije —
ne vzdržujemo ločenega `tenant_id` na vsakem modelu (duplikat istega dejstva).

## Pravila (implementirano v1.35.0)

1. **Lokacijske vloge** (manager/staff/waiter/bar/chef/kitchen/warehouse/accounting):
   dostop IZKLJUČNO lastna lokacija — `assertResourceLocation` / `locationScope`
   (src/lib/api.ts, issue #4 §1). To po konstrukciji preprečuje cross-tenant.
2. **Enterprise vloge** (group_owner/org_admin/property_manager): preklok čez
   lokacije SAMO znotraj istega org/property — `enterpriseAllows`
   (src/lib/enterprise.ts, issue #11), fail-closed brez verige.
3. **Centralne vloge** (ADMIN/OWNER) — cross-location dostop je od v1.35.0
   dodatno omejen z tenant mejo: `assertTenantScope` (src/lib/tenant.ts):
   - org uporabnika ≠ org vira (obe znani) → **403**;
   - org uporabnika ali vira neznana (legacy, nevezani podatki) → obstoječe
     lokacijsko vedenje (migracijsko varno — ne odrežemo produkcije);
   - **bootstrap admin** (`sub='bootstrap'`) = break-glass za obnovo dostopa, gre
     skozi (izrecno odločitev, dokumentirana tudi v SECURITY-BOUNDARY.md).
4. **Kreiranje organizacij** = platformna operacija (SaaS onboarding): samo
   bootstrap (POST /api/enterprise `kind:'organization'`). Brand/property
   kreacija in link-location → samo znotraj organizacije uporabnika.
5. **GET /api/enterprise** vrne SAMO organizacijo uporabnika (prej: vse — zaprto
   uhajanje). Bootstrap vidi vse.

## Pokritost ostalih poti (inv. §0)

| Pot | Tenant varnost |
|---|---|
| Webhooki (Glovo/Wolt) | `Integration.locationId` vezava; naročilo nastane na lokaciji integracije; cancel cross-location → 403 + audit `DELIVERY_CANCEL_BLOCKED` (v1.32.0 D6) |
| Sync (/api/sync) | `requireAuth` + `user.loc` sidro; `assertResourceLocation` na order.addItems/kitchen.status; idempotencija `DeviceSyncOperation` |
| Javni QR/kiosk | lokacija/miza se rešita SERVER-SIDE iz qrToken/device žetona — client ID-ji niso zaupani (src/lib/guest.ts) |
| Export (/api/reports/export) | `locationScope` + relacijski scope (Check→Order, InventoryItem) |
| Device enroll | enkratna koda (8 mest, kratka veljavnost) + lokacijska vezava ob claim-u; revoke = `DeviceRegistry.revokedAt` |
| Print | `/api/print/*` zahteva žeton (requireAuth) |

## Testi

- `tests/tenant.test.ts` — cross-org READ/WRITE DENY, forged org/location ID,
  legacy passthrough, hierarhična pravila ostanejo (regresijski guard).
- `tests/enterprise.test.ts` — drevo + obseg (#11).

## Znane meje (transparentno)

- Legacy lokacije brez `propertyId` NISO pod tenant mejo (org neznana) — varuje
  jih lokacijski sloj. Ko se povežejo v drevo (link-location), meja postane stroga.
- Per-tenant unikatni indeksi: trenutno globalni (npr. `Employee.email`,
  `Location.code`) — za SaaS z več orgi se naslavlja ob onboardingu (odprto v
  issue #5 kot enterprise control plane); ni blokator za trenutno topologijo.
