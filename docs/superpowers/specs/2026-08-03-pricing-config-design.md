# DNS Logistics — Pricing Configuration Dashboard

**Design spec · 2026-08-03**

## 1. Goal

Replace three Excel rate-card workbooks with a web dashboard where a pricing-configuration
team edits rates and an admin approves those edits before they affect any quote.

Two hard requirements from the product owner:

1. **The UI must look and behave like an Excel sheet.** Not "a table" — a spreadsheet: tab
   strip, column letters, row numbers, cell references, keyboard navigation.
2. **Nothing reaches a live quote without admin approval.**

Functionality may improve on Excel. The *look* may not deviate from it.

## 2. Source data

Three workbooks, supplied by the product owner:

| File | Referred to as |
|---|---|
| `DNS_Rate_Card_v15.xlsx` | Model 1 |
| `DNS_Rate_Card_Model2.xlsx` | Model 2 |
| `DNS_Rate_Card_Model3.xlsx` | Model 3 |

### 2.1 Sheet inventory (identical in all three files)

| Sheet | Shape | Editable? |
|---|---|---|
| DNS Logistics | cover + how-to-use prose | no (static) |
| Rate Calculator | single-shipment quote | **derived** |
| Ex-Origin Rate Card | one origin → all destinations, base freight | **derived** |
| All-In Quote | one origin + weight → all destinations, landed cost | **derived** |
| Air Rates | 4 stacked 12×12 matrices at rows 3 / 18 / 33 / 48 | yes |
| Surface Rates | 4 stacked 21×21 matrices at rows 3 / 27 / 51 / 75 | yes |
| Rail Rates | 4 stacked 21×21 matrices at rows 3 / 27 / 51 / 75 | yes |
| NFO Rates | every Air Rates cell × 2 | **derived** |
| Pickup & Delivery | 21 zones × {Pickup,Delivery} × {Surface,Air} | yes |
| TAT Air | 12×12 transit days | yes |
| TAT Surface | 21×21 transit days | yes |
| ETA Rail | 21×21 transit days | yes |
| Cluster Guide | 21 surface clusters, 12 air hubs | yes |
| EDL Matrix | ODA surcharge, km-band × weight-band | yes |
| Charges & Terms | global params + 8 terms paragraphs | yes |
| Pincode Master | 19,494 × 21 — per-mode zone, hub, EDL km, ODA | yes (special UI) |

### 2.2 The three models are three different freight formulas

Established by cell-by-cell diff of all three workbooks. They differ **only** in:
Air Rates (358 cells), Surface Rates (1,240), Rail Rates (1,093), the cover title, and
9 Rate Calculator formula cells. Every other sheet has **zero** differing cells.

Those 9 formula cells are the important part — the models are not merely different numbers:

| Model | Freight formula | Calculator |
|---|---|---|
| **1** | `minCharge + Σ(kg falling in each slab × that slab's rate)` — progressive | `D30 = D26+D27+D28+D29` |
| **2** | `minCharge + applicableRate × (chargeableWt − minWt)` | `D30 = D26+D28` |
| **3** | `MAX( minCharge , applicableRate × chargeableWt )` | `D30 = MAX(D26,D28)` |

where `applicableRate` is a **single** rate chosen by total chargeable weight:
`wt ≤ 100 → tier1 · wt ≤ 300 → tier2 · else tier3`.

**All three models still require all four grids per mode** — Models 2 and 3 use tiers 1/2/3
as the lookup table for which single rate applies. The schema is therefore genuinely
identical across models, and the pricing method is a *field on the rate card*, not a
different shape of data.

Every step **after** freight is identical in all three models.

### 2.3 Zone codes

- Surface & Rail (21): `PNQ PCMC KSK CSN BOM NAG AMD IDR NCR BWR UTR LDH UPX BLR HSR MAA CJB HYD CCU JSR GAU`
- Air & NFO (12): `PNQ BOM AMD IDR NCR UTR BLR MAA HYD CJB CCU NAG`

`'-'` in a rate cell means the mode is not available on that lane.

### 2.4 Defects in the source workbooks

Carried here so they are decided deliberately rather than inherited by accident.

| # | Defect | Resolution |
|---|---|---|
| 1 | Header prose says slabs are `100–500 / 500+`; matrices are `100–300 / 300+` | Correct the prose. Matrices are authoritative. |
| 2 | Cluster Guide titled "SURFACE CLUSTERS (20)"; there are 21 codes | Correct to 21. Derive the count, don't hardcode it. |
| 3 | `Charges & Terms` col B is a stale display copy contradicting authoritative col E (B6 "Pickup Surface 800" vs E6 = 100) | Single source of truth. One value per param. |
| 4 | GST hardcoded `0.18/0.05` in `D38`; the "editable" GST param is never read | Wire GST to the param, **seeded at 18% air / 5% surface**. Day-one output is unchanged; GST becomes genuinely editable. |
| 5 | Fuel applied to `freight + P&D + ODA`, but Charges & Terms describes it as "on freight" | **Formula is correct** (confirmed by product owner). Fix the note text. |
| 6 | In M2/M3, `B27:B29` retain Model 1's slab-splitting formulas while row labels were changed — displays numbers contradicting their own labels | Do not reproduce. Show only what each model actually uses. |
| 7 | Workbooks contain **no cached formula values** — every derived cell is empty until a calc engine runs | Informational; affects fixture generation (§10). |

## 3. Decisions

| Area | Decision |
|---|---|
| Stack | **Next.js (Node) + MongoDB, hosted on AWS** — matches the existing company website this app will call in future |
| Models | **Three rate cards over one schema**, each carrying its own `freightMethod` and its own numbers |
| Live models | **All three are live simultaneously** — there is no single "active" card |
| Model selection | **Every quote shows all three side by side.** No selection step |
| Editable scope | Every non-derived data sheet: rate matrices, Charges & Terms globals, Pickup & Delivery, EDL, transit times, Cluster Guide, Pincode Master. The DNS Logistics cover is static prose, not data |
| Auth | Email + password, three roles: Configurator, Admin, Viewer |
| Approval unit | A **changeset** the team submits when ready; admin approves/rejects in bulk or line by line |
| Pincode Master | Searchable table + CSV import/export with diff preview — not a 19,494-row grid |
| Excel fidelity | Full: 16 tabs in order, column letters + row numbers + cell refs, Excel keyboard behaviour, HOW TO READ panels in place |
| Fuel base | `freight + pickup + delivery + both ODA` — unchanged |
| GST | Param-driven, seeded to current effective values; final policy still open (§13) |

## 4. Architecture

Four layers, each independently testable, with dependencies pointing one direction only.

| Layer | Contents | Depends on |
|---|---|---|
| `pricing/` | Pure functions. `quote(input, card, refData) → Breakdown`. All three freight methods. | nothing |
| `sheets/` | 16 layout specs + coordinate ↔ domain-path resolver | zone constants |
| `data/` | Mongo repositories, versioning, changesets, audit | mongodb |
| `app/` | Next.js routes + grid component | all three |

`pricing/` having **zero dependencies** is deliberate: it is fully unit-testable against
the spreadsheet, and it is what gets exposed as `POST /api/quote` to the existing website
later without dragging in a database or a React tree.

### 4.1 Collections

**`rateCards`** — exactly 3 documents.

```ts
{ key: 'model-1' | 'model-2' | 'model-3',
  name: string,
  freightMethod: 'CUMULATIVE_SLABS' | 'MIN_PLUS_EXCESS' | 'MAX_MIN_OR_FULL',
  liveVersionId: ObjectId,
  draftVersionId: ObjectId }
```

**`rateCardVersions`** — one document per version, holding every grid for that card.

```ts
{ rateCardId, version: number,
  state: 'draft' | 'pending' | 'live' | 'archived',
  grids: {
    air:     { minCharge: Grid12, tier1: Grid12, tier2: Grid12, tier3: Grid12 },
    surface: { minCharge: Grid21, tier1: Grid21, tier2: Grid21, tier3: Grid21 },
    rail:    { minCharge: Grid21, tier1: Grid21, tier2: Grid21, tier3: Grid21 },
  },
  pickupDelivery, edlMatrix, transitTimes, charges, zones,
  createdBy, createdAt, approvedBy, approvedAt, changeRequestId }
```

A grid is `Record<originCode, Record<destCode, number | null>>`, where `null` is the `'-'`
of the spreadsheet. One card is roughly 4,100 numbers — far inside Mongo's 16 MB document
limit, so **a whole rate card loads in a single query**. That is what makes the grids feel
instant and makes the future API a single lookup.

**`pincodes`** — 19,494 documents, **shared across all three cards** (identical in all
three source files, and operational rather than pricing data). Indexed on `pincode`.
Carries its own draft/approval cycle.

**`changeRequests`**

```ts
{ target: { type: 'rateCard' | 'pincodes', id, versionId },
  submittedBy, submittedAt,
  status: 'pending' | 'approved' | 'rejected' | 'partially-approved',
  changes: [{ path, sheet, cellRef, label, oldValue, newValue, pctChange,
              decision?: 'approved' | 'rejected', comment? }],
  reviewedBy, reviewedAt, reviewComment }
```

**`users`** — `{ email, passwordHash, name, role, active }`
**`auditLog`** — append-only: every submit, approve, reject, and promotion.

### 4.2 Draft / live separation

Edits land in the card's `draftVersionId`, so the team works freely without touching
anything customer-facing. Submitting flips that version to `pending` and opens a
changeset. Approval promotes it to `live`, archives the previous live version, and forks
a fresh draft.

**Quotes always read `liveVersionId`.** Pending edits cannot leak into a customer-facing
number. Because every version is retained, "what did we quote in June?" is answerable
exactly.

While a version is `pending` the draft is **locked** — otherwise the changeset an admin is
reviewing drifts from what they were shown. Rejection unlocks it.

## 5. Pricing engine

```
quote(input, card, refData) → Breakdown
  input:   { mode, fromPincode, toPincode, actualWeight,
             length?, breadth?, height?, pieces?, singlePackageOver100kg? }
```

**Step 1 — resolve pincodes.** Look up origin and destination in `pincodes` to get, per
mode: serviceability, zone code, and EDL km. Unserviceable → return a typed reason, not a
number.

**Step 2 — chargeable weight.**
```
volumetric      = L × B × H × max(pieces,1) ÷ divisor        (air 5000, surface/rail 4500)
chargeableWeight = max(actualWeight, volumetric, minWeight)   (air 25 kg, surface/rail 50 kg)
```
Rail override: if a single package ≥ 100 kg, `chargeableWeight = 2 × actualWeight`.

**Step 3 — freight**, per the card's `freightMethod`.

`mode` is one of `air | surface | rail | nfo`. **NFO is not stored** — it is derived as
`2 × air` on every one of the four grids, matching the source workbook, so editing Air
Rates moves NFO with it. Rail additionally requires the lane to exist in the rail grids
(the source restricts rail to lanes over roughly 800 km, expressed as `-` cells).

```
minCharge      = grid[mode].minCharge[origin][dest]      // null → lane unavailable
applicableRate = chargeableWeight <= 100 ? tier1
               : chargeableWeight <= 300 ? tier2
               : tier3

CUMULATIVE_SLABS   min + tier1×clamp(wt−minWt, 0, 100−minWt)
                       + tier2×clamp(wt−100, 0, 200)
                       + tier3×max(wt−300, 0)
MIN_PLUS_EXCESS    min + applicableRate × max(wt − minWt, 0)
MAX_MIN_OR_FULL    max( min , applicableRate × wt )
```

**Step 4 — accessorials, in this exact order.**
```
pickup    = origin zone ≠ dest zone ? pickupDelivery[origin][mode] : 0
pickupODA = edl(originEdlKm, chargeableWeight)
delivery  = origin zone ≠ dest zone ? pickupDelivery[dest][mode]   : 0
deliveryODA = edl(destEdlKm, chargeableWeight)
fuel      = round((freight + pickup + pickupODA + delivery + deliveryODA) × fuelPct, 1)
              where fuelPct = 0 for rail
docket    = charges.docket
subTotal  = freight + pickup + pickupODA + delivery + deliveryODA + fuel + docket
gst       = round(subTotal × gstPct, 1)
total     = subTotal + gst
```

**`edl(km, weight)`** — `km ≤ 0 → 0`; `km > 500 → 14 × km`; otherwise approximate-match on
km bands `20/51/101/151/201/251/301/401` and weight bands `0/101/251/501/1001`. A km value
below the lowest band yields 0.

**Returns a full breakdown**, not a scalar — every line above, plus the resolved zones,
chargeable-weight derivation, applicable rate, and transit time. The Rate Calculator
renders this directly, so the UI never re-derives arithmetic.

**All three models are computed for every quote** and shown side by side.

## 6. Sheet layout specs

Each of the 16 tabs is described declaratively. One spec drives rendering, cell
addressing, and change labelling.

```ts
{ id: 'surface-rates', name: 'Surface Rates',
  blocks: [
    { type: 'title',  at: 'A1', text: 'SURFACE PARTLOAD (PTL) — …' },
    { type: 'matrix', at: 'A3', title: 'MINIMUM CHARGE (Rs)',
      rowKeys: SURFACE_ZONES, colKeys: SURFACE_ZONES,
      bind: 'grids.surface.minCharge' },
    { type: 'matrix', at: 'A27', title: 'RATE 50-100 kg (Rs/kg, all-in D2D)',
      bind: 'grids.surface.tier1' },
    { type: 'matrix', at: 'A51', title: 'RATE 100-300 kg',  bind: 'grids.surface.tier2' },
    { type: 'matrix', at: 'A75', title: 'RATE 300+ kg',     bind: 'grids.surface.tier3' },
    { type: 'notePanel', at: 'X3', title: 'HOW TO READ — SURFACE', lines: [ … ] },
  ]}
```

This is what lets Excel fidelity and a reviewable approval queue coexist: the resolver
maps `Surface Rates!J5` ↔ `grids.surface.minCharge.PNQ.NCR` in both directions, so a
changeset line can read

> `Surface · min charge · PNQ→NCR · 530 → 560 (+5.7%)`

instead of `J5 changed` — which an approver can actually judge.

## 7. Excel-grid UI

**Chrome:** 16-tab strip in original order; column letters `A…AC`; row numbers; a name box
showing the active cell reference; a value bar.

**Keyboard:** arrow navigation · Tab/Enter to commit and advance · type-to-replace · F2 to
edit in place · Esc to cancel · Shift+arrows and Shift+click to select ranges · Ctrl+C/V
across ranges · Ctrl+Z/Y undo/redo · Ctrl+D fill down · Delete to clear.

**Cell states**, reusing the spreadsheet's own yellow-means-editable convention:

| State | Treatment |
|---|---|
| Label / header | grey, not focusable for editing |
| Editable | yellow, as in the source |
| Locked (role or pending) | yellow with hatch, read-only |
| Dirty (unsubmitted) | blue corner marker |
| Pending approval | amber |
| Rejected | red, with the reviewer's comment on hover |
| Derived | grey italic |
| Unavailable lane | `-` |

**Built, not borrowed.** The grid is the product. Off-the-shelf grids fight this exact
combination of demands — A1 addressing, per-cell approval state, matrix blocks stacked on
one sheet, note panels at fixed coordinates. A focused component is less work than bending
a library and does not cap fidelity.

Matrix headers stick on scroll (an improvement on the source, which has no frozen panes).

**Derived tabs** — Rate Calculator, Ex-Origin, All-In Quote, NFO — compute live from
`pricing/` and are read-only. Rate Calculator additionally shows all three models
side by side.

## 8. Approval workflow

```
Configurator                          Admin
────────────                          ─────
edits draft (free, no approval)
      │
      ├─ validation warnings shown inline (§9)
      │
      └─ Submit for approval ──────►  Change request queue
                                            │
                                      reviews diff: sheet, cell ref,
                                      human label, old → new, % change
                                            │
                     ┌──────────────────────┼──────────────────────┐
                Approve all            Reject all           Line-by-line
                     │                      │                      │
              version → live         back to draft,      approved cells → live,
         previous live archived      comment attached     rejected → draft with
         fresh draft forked                              per-line comments
```

Everything lands in `auditLog`. The queue is in-app; email notification is out of scope
for v1.

## 9. Validation guardrails

Shown inline to the configurator while editing and repeated on the admin's diff, because
a reviewer looking at 1,200 changed cells needs the risky ones surfaced.

- **Decremental invariant:** `tier1 ≥ tier2 ≥ tier3` per lane. Every sheet header claims
  rates "step down by weight"; a violation means somebody fat-fingered a tier.
- **Large movement:** any cell changing more than a configurable ±% (default 10).
- **Non-positive** rate or minimum charge.
- **Below-cost floor**, once a cost basis exists — deliberately deferred, no cost data yet.
- **Broken symmetry:** lane A→B differing from B→A by more than a threshold. The source
  matrices are near-symmetric, so asymmetry is usually a typo.
- **Newly unavailable lane:** a number replaced by `-`, or the reverse.

Warnings never block submission. They annotate.

## 10. Verification

**Golden fixtures from the spreadsheet itself.** The source workbooks carry no cached
values (defect 7), but LibreOffice recalculates them headlessly:

```
soffice --headless --convert-to xlsx --outdir out/ <file>.xlsx
```

Confirmed working, and confirmed to reproduce the documented math:

```
Model 1 · Surface · PNQ→NCR (411001→122001) · 200 kg
  min charge (≤50 kg)   530
  50–100 kg   50 × 15 =  750
  100–300 kg 100 × 14 = 1400
  300+ kg      0 × 12 =    0
  freight               2680
  pickup 400 · delivery 800 · ODA 0/0
  fuel 25% × 3880       970
  docket                100      sub-total 4950
  GST 5%             247.50      TOTAL    5197.50
```

**Plan:** script the Excel across a matrix of inputs — 3 models × 4 modes × a spread of
origin/destination pairs (intra-zone, inter-zone, ODA, unserviceable, unavailable-lane) ×
weights that straddle every slab boundary (1, 25, 26, 50, 51, 100, 101, 300, 301, 1000) —
recalculate, and export expected breakdowns as fixtures. `pricing/` is then asserted
against them to the rupee. Boundary weights matter most: that is where the three models
diverge and where an off-by-one in a slab comparison hides.

Layered on top: unit tests for the ODA band lookup and chargeable-weight rules;
integration tests for the approval state machine (including the concurrent-edit lock and
partial approval); and a round-trip test that the layout resolver maps every editable cell
to a domain path and back.

## 11. Migration

A one-off importer reads the three workbooks and writes: three `rateCards` with the
correct `freightMethod`, one `live` version each, and the shared `pincodes` collection.
Idempotent and re-runnable. It asserts the invariants proven in §2.2 — identical sheet
structure, identical non-rate sheets, expected grid dimensions — and fails loudly rather
than importing something subtly different, so a corrected workbook can be re-imported
safely later.

## 12. Out of scope for v1

Email/Slack notifications · customer-specific rate cards or negotiated overrides ·
quote history and persistence · PDF/Excel quote export for customers · the live API
endpoints for the existing website (the engine is built to be exposed; the endpoints and
their auth are a separate piece of work) · FTL and >1000 kg pricing, which the source
marks as quoted separately · cost basis and margin analysis.

## 13. Open questions

1. **GST policy** — undecided by the product owner. Wired to a param and seeded at 18%
   air / 5% surface, matching current effective behaviour, so nothing is blocked. Needs a
   decision before rollout only if the intent differs.
2. **AWS deployment shape** — Amplify Hosting, ECS/Fargate behind an ALB, or OpenNext on
   Lambda + CloudFront. Default: match whatever the existing Next.js site uses. Needs
   confirmation before the deployment task.
3. **User list and role assignment** — how many configurators and admins, and who seeds
   the first admin account.
4. **Zone changes** — the Cluster Guide is editable, but adding or removing a zone
   reshapes every 21×21 matrix. v1 will allow renaming and re-describing zones, and treat
   add/remove as an explicit, separately-confirmed migration rather than a cell edit.
