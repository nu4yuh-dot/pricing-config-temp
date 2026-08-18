# DNS Logistics — Pricing Configuration

A pricing configuration platform that replaces three Excel workbooks. The pricing team edits
base rates and negotiates customer contracts; an admin approves every change before it can
affect a quote or a booking. Two interfaces over the same data: a pricing console and a
spreadsheet-identical grid.

Design spec: [`docs/superpowers/specs/2026-08-03-pricing-config-design.md`](docs/superpowers/specs/2026-08-03-pricing-config-design.md)

## Getting started

```bash
npm install
cp .env.example .env.local          # set SESSION_SECRET: openssl rand -base64 48

python3 scripts/extract.py          # workbooks  -> data/extracted/*.json
npx tsx scripts/seed.ts --admin-password '<at least 12 chars>'

npm run dev
```

`extract.py` defaults to `~/Downloads`; pass `--workbook-dir` for another location.

## Layout

| Path | What it is |
|---|---|
| `src/pricing/` | The engine. Pure functions, zero dependencies. |
| `src/customers/` | Contract resolution: sparse overrides, coverage checks, proposals. |
| `src/console/` | Lane-shaped view of the card, for the console UI. |
| `src/sheets/` | The sixteen tab layouts plus the coordinate ↔ domain-path resolver. |
| `src/changes/` | Changeset diffing and validation guardrails. |
| `src/data/` | Mongo repositories and the approval state machine. |
| `src/auth/` | Roles and sessions. |
| `src/components/` | The spreadsheet grid and its wrappers. |
| `src/app/` | Next.js routes and server actions. |
| `src/app/api/` | The endpoints the booking website calls. |
| `scripts/` | Excel extraction, fixture generation, seeding, verification. |

`src/pricing/` deliberately depends on nothing. It is unit-testable against the spreadsheets
and is what gets exposed as an API to the existing website later, without dragging in a
database or a React tree.

## Commands

```bash
npm test                              # 816 unit tests
npm run typecheck
npm run build

python3 scripts/extract.py            # workbooks -> JSON
npx tsx scripts/apply-settlement-defaults.ts   # fill tax/fuel/charge config on extracted cards
npx tsx scripts/migrate-settlement.ts          # same, for cards already in Mongo
python3 scripts/generate_fixtures.py  # regenerate golden fixtures (needs LibreOffice)
python3 scripts/generate_franchise_fixtures.py  # the same, for the Bluedart card
python3 scripts/extract_bluedart.py   # merge Bluedart zones into the pincode master
npx tsx scripts/build-bluedart-card.ts          # build the Bluedart card artefact
npx tsx scripts/migrate-bluedart.ts   # push Bluedart zones onto pincodes already in Mongo
npx tsx scripts/seed.ts [--reset]     # seed Mongo
npx tsx scripts/verify-workflow.ts    # exercise the approval flow against real Mongo
npx tsx scripts/verify-contracts.ts   # exercise contracts + booking exceptions
npx tsx scripts/verify-billing.ts     # exercise the money path against real Mongo
npx tsx scripts/smoke.ts --base http://127.0.0.1:3000
npx tsx scripts/analyse-monotonicity.ts
```

## How pricing works

Each mode carries four origin × destination matrices: a fixed/minimum charge and three per-kg
tiers. How those four numbers become freight is the **only** thing that separates the three
rate cards:

| Card | `freightMethod` | Freight |
|---|---|---|
| Model 1 | `CUMULATIVE_SLABS` | `min + Σ(kg in each slab × its rate)` — progressive |
| Model 2 | `MIN_PLUS_EXCESS` | `min + oneRate(total wt) × (wt − minWt)` |
| Model 3 | `MAX_MIN_OR_FULL` | `max(min, oneRate(total wt) × wt)` |

Everything after freight is identical across all three, and is settled in one place
(`src/pricing/settlement.ts`):

```
freight → +pickup → +pickup ODA → +delivery → +delivery ODA
        → +fuel (on the configured base) → +charges → sub-total → +GST → total
```

Three things about that order are configurable per card, on the **Tax & Charges** tab:

- **GST follows the mode, not the customer.** Road freight is GTA — 5%, and under reverse charge
  the consignee accounts for it, so the quote shows zero GST and states the rate because the
  invoice must. Air is 18% forward. Each mode carries its SAC code, rate, reverse-charge and ITC
  position.
- **What fuel is charged on.** The workbooks levied it on freight plus both cartage legs and both
  ODA legs, never on the docket. Some contracts charge it on *total charges* instead. Both, and
  anything between, are expressible.
- **The charge menu.** Rather than one docket field: a list of ancillary charges, each with its own
  basis (per shipment, per AWB, per kg, from the pincode distance, per destination zone), whether
  it sits inside GST, whether fuel is levied on it, and which modes it applies to. A charge outside
  GST is added after tax, which is right for a deposit or a reimbursement.

Every one of those values is a cell on a tab, so it is edited, diffed and approved like any rate.
A card that declares none of them behaves exactly as the workbooks do — which is why the 150
golden fixtures still match to the paisa.

## FTL — full truck load

FTL is not the partload engine with a bigger number in it, and it is deliberately not routed
through `quote()`. A truck is hired whole, so there are no weight tiers, no chargeable weight and
no minimum charge: the price is one figure per vehicle per lane, which is how the contracts on file
state it (A Raymond, Pune→Bangalore, ₹33,000).

- Nine vehicles, from a Tata Ace at 750 kg to a 40 ft trailer at 25 t, ordered by payload — a 32 ft
  single-axle is longer than a 22 ft truck but carries less, and ordering by length would make a
  keying error invisible.
- One origin × destination matrix per vehicle on the **FTL Rates** tab, stacked the way the source
  workbooks stack their four rate matrices. An empty cell means that vehicle is not offered on that
  lane — never that it is free.
- Everything after freight is shared with partload: the same fuel base, the same charge menu, and
  FTL's own tax treatment of 12% with input tax credit (SAC 9965).
- `GET /api/quote/ftl?vehicle=&from=&to=` — a separate endpoint, because an FTL booking names a
  vehicle rather than a weight. For FTL, coverage *is* the rate matrix: an unrated lane comes back
  unavailable, and there is no base price to fall back on, because an unrated truck lane has no
  standard price — it has simply never been quoted.

**Margin.** A card can also carry a **buy tariff** (`data.cost`) in the same four-grid shape as
sell, so the same freight function prices both sides. Where one exists, a quote reports the
coloader's cost, the profit and the ratio, and warns when a lane is thin or under water. Freight is
compared with freight — never a landed sell price against a bare buy rate, which would flatter
every lane.

## Bluedart — a second product

The DNS cards are one product priced three ways. Bluedart is a **different product**, and the
system now says so: a card carries a `product`, tabs and console pages belong to one product, and
the two never appear in the same comparison.

Four things about it are structurally unlike the DNS cards:

- **Directional zones, not a lane matrix.** Everything ships ex-Pune, so the price depends only on
  the destination: five zones by distance — WEST (nearest) < NORTH = SOUTH < EAST < NE & REMOTE.
- **Four services with their own weight rules.** DOCs and DUTS are billed per 500 g against a floor
  (₹50 / ₹200) with minimums of 0.5 and 1 kg; APEX and SURFACE have a fixed first block (5 kg / 10
  kg) and then per-kg slabs.
- **Incremental slabs.** Each band's rate applies only to the kilograms in that band, and the bands
  are added — so a heavier shipment always costs more. The DNS cards are decremental, where one
  more kilogram across a boundary can cost *less*.
- **Its own charges.** AWB ₹100, FOV at 0.33% of declared value with a ₹200 floor, and fuel at
  92% air / 65% surface levied on freight **plus ODA**. Documents carry fuel only — no AWB, no FOV,
  no ODA — and take the air percentage. GST is 18% throughout, SAC 9968.

`GET /api/quote/bluedart?to=&weight=` prices all four services at once, so a desk can see the
alternatives without four round trips; add `service=` for one.

**Verification.** 127 golden fixtures generated by driving the workbook's own Calculator through
headless LibreOffice, compared with `toBe`. The workbook rounds nothing — its GST on a 30 kg
surface shipment is ₹177.9975 — so neither does the engine; what is applied is Excel's own limit of
15 significant digits per cell, which removes floating-point noise without touching a real value.

**Two deliberate divergences from the workbook**, each asserted in the suite:

| The workbook | This engine |
|---|---|
| An unknown pincode prices at nil freight and still bills AWB, FOV and GST — ₹354 for a shipment it cannot route | Refuses to quote |
| Quotes APEX to the 15 pincodes its own master marks `Not in APEX` | Refuses APEX there, and says SURFACE is available |

**Rules the card states but its Calculator never implemented**, now enforced: volumetric weight
(air and DUTS at L×B×H/5000, surface at (L×B×H/27000)×8, greater of actual and volumetric).
DOCs and DUTS above 5 kg are flagged rather than blocked — the card says they move to APEX or
SURFACE, but the desk may have a reason.

## Money

A customer's wallet, credit position and invoices, held as one **append-only ledger**.

- **Integer paise, everywhere.** A balance is summed every time it is shown, over years of
  entries, and rupees held as floating point drift — `0.1 + 0.2` is not `0.3`. In a quote that
  rounds at the end this is harmless; in a running balance it accumulates into somebody's money.
  Rupees appear only at the edges.
- **Nothing is edited or deleted.** A wrong entry is corrected by a reversing entry naming the one
  it undoes, so any balance can be reconstructed from the entries that produced it. An entry cannot
  be reversed twice.
- **No stored balances.** Every figure is a replay of the entries through pure, tested functions.
  A stored total is a second source of truth, and when the two disagree there is no way to tell
  which is right.
- **One account, not a wallet plus a receivable.** Money in is a recharge or a payment; money out
  is an invoice or a refund. A prepaid customer runs positive, a credit customer runs negative
  between invoice and payment — and money already paid in genuinely reduces what they owe, rather
  than their exposure being counted twice.
- **Duplicate-proof.** Entries are unique per customer, kind and reference, so a retried gateway
  callback or a double-clicked button records the money once. A payment carries its own UTR *and*
  the invoice it settles, because conflating the two makes a second part payment look like a repeat
  of the first.
- **Invoices are one per mode.** A tax rule, not a preference: road is 5% (and under reverse charge
  is not billed at all) while air is 18% forward, on different SAC codes. Two GST rates inside one
  mode are refused rather than averaged. Invoice numbers are deterministic, so raising a period
  twice collides instead of billing again.
- **Bookings are gated on money.** `GET /api/quote` with a customer returns **402** when the price
  is agreed but the funds are not there, with the reason and the shortfall. Overdue money holds
  bookings whatever the limit says.

Recording money needs the `record-money` capability, which only an admin has — deliberately
separate from approving a rate change, since a pricing configurator has no business touching a
customer's balance.

## Two interfaces

The same data, the same drafts and the same approvals, reached two ways. The switch is in
the masthead and the choice is remembered per person.

- **Console** (default) — work is organised by what you are changing. Pick a lane from three
  dropdowns and edit four labelled fields with the resulting quote live beside them; change
  hundreds of lanes with one bulk operation; edit charge parameters as a form. No cell
  references to know.
- **Sheet** — the workbook reproduced exactly: A1 addressing, the value bar, Excel keyboard
  behaviour, all sixteen source tabs plus Tax & Charges. For people who would rather keep working
  the way they always have.

## Contract customers

A contract is the base rate card plus **only the cells that were negotiated**. A customer who
agreed three lanes stores three values, not a copy of the card — so they keep tracking base
changes everywhere they have not negotiated, automatically and for free.

```
effective price = base card  →  apply this customer's overrides  →  quote
```

A contract also has a **coverage scope**: which modes, lanes and weight bands it actually
includes. Every field is nullable and `null` means "no restriction", so a freshly onboarded
customer is unrestricted and priced exactly like everyone else until something is agreed.

Negotiated rates go through the same review as a base-card change, and reuse the same diff —
an approver reads `Surface Rates · min charge · PNQ→NCR · 530 → 450 (−15.1%)`, not a raw
override map. Nobody can approve their own proposal.

## The booking website's API

All endpoints need `x-api-key` (`BOOKING_API_KEY`), compared in constant time, failing closed
if unset.

| | |
|---|---|
| `POST /api/customers` | Register a customer. Idempotent — retries return the existing one. A new customer starts on the base card with nothing negotiated and nothing restricted, so onboarding can never move a price. |
| `GET /api/customers` | List customers with how many cells each has negotiated. |
| `GET /api/quote` | Quote a shipment. With `customer=`, uses their contract and checks coverage. Without it, returns all three base cards. |
| `GET /api/quote/bluedart` | Price the franchise card by destination and weight. All four services, or one via `service=`. |
| `GET /api/quote/ftl` | Quote a full truck by vehicle and lane. No weight; coverage is the rate matrix. |
| `GET /api/quote` (402) | In contract but unfunded: reason, shortfall, and the message to show the operator. |
| `POST /api/bookings/exceptions` | Raise a booking that falls outside a contract. Returns a reference. |
| `GET /api/bookings/exceptions?reference=` | Poll a reference. Book only when `bookable: true`. |

**Out-of-contract flow**, which is what the business asked for:

1. `GET /api/quote?customer=ACME&…` for a lane outside their contract returns **409** with
   `bookable: false`, the specific reasons, and the **base price as a fallback** clearly
   labelled as not contracted.
2. If the customer accepts that price, `POST /api/bookings/exceptions` creates a request for
   an admin and returns a reference.
3. The booking site polls the reference. Until it reads `approved`, the booking must not
   proceed.
4. On approval the admin can also fold the lane into the contract permanently, so the same
   booking stops needing approval every time.

## Correctness

The engine is verified against the workbooks themselves. `scripts/generate_fixtures.py`
duplicates each workbook's own Rate Calculator once per test case, recalculates the file
headlessly in LibreOffice, and captures what Excel computes. `src/pricing/golden.test.ts`
then asserts the engine matches **all 150 cases to the rupee**, across three models, four
modes, every slab boundary, both ODA paths, volumetric weight, rail's heavy-package rule,
intra-zone lanes, unavailable lanes and unknown pincodes.

Regenerate the fixtures whenever the source workbooks change.

## Known problems in the source workbooks

Found while building this, and each one resolved deliberately rather than inherited. Full
register in the design spec §2.4.

1. Slab headers said `100–500 / 500+`; the matrices are `100–300 / 300+`.
2. Cluster Guide claimed 20 clusters; there are 21.
3. `Charges & Terms` held every parameter twice — a display copy and an editable copy — which
   had drifted apart (`Pickup Surface` showed 800 against an actual 100).
4. GST was hardcoded in the calculator, so editing the "editable" GST cell did nothing. It is
   now a real parameter, seeded to the values that were hardcoded, so day-one output is
   unchanged.
5. The fuel note said "on freight" while the formula charged freight + P&D + ODA. **The
   formula was right**; the note is corrected.
6. In Models 2 and 3 the `Chg wt` column still held Model 1's formulas after the labels were
   changed, displaying numbers that contradicted their own row labels.
7. The workbooks carry no cached formula values at all — every derived cell is empty until
   something recalculates them.
8. **`All-In Quote` hardcoded Model 1's freight formula in all three files**, so opening the
   Model 2 or Model 3 workbook and reading that tab showed Model 1 prices.
9. `All-In Quote` rounded fuel and GST to whole rupees while `Rate Calculator` rounded to one
   decimal — two tabs in one file disagreeing about the same shipment.
10. The calculator never checked serviceability; an unserviceable pincode still priced. The
    engine reports it as a warning rather than silently pricing.
11. Two rail lanes to Guwahati (`UTR→GAU`, `UPX→GAU`) price the 300+ kg tier **above** the
    100–300 kg tier, contradicting the documented decremental rule.
12. Two surface lanes into Guwahati are 110% asymmetric against their reverse direction.

Items 11 and 12 are live data, not code, and are surfaced as validation findings rather than
changed.

## Open: pricing that falls as weight rises

Models 2 and 3 apply a **single** decremental tier rate, so crossing a tier boundary reprices
the whole shipment lower. Measured across all 1,010 lanes × 2 boundaries per card by
`scripts/analyse-monotonicity.ts`:

| Card | Crossings where +1 kg costs less | Worst case |
|---|---|---|
| Model 1 | 0 of 2,020 | — |
| Model 2 | 1,554 of 2,020 (77%) | air BLR→MAA at 300 kg: ₹13,490 → ₹9,116 |
| Model 3 | 1,134 of 2,020 (56%) | air NCR→BLR at 300 kg: ₹15,600 → ₹9,632 |

Model 1's progressive slabs cannot do this by construction. This is faithful to the
spreadsheets — Excel produces the same numbers — and **has not been changed**, because it
moves real prices. It is reported as the `price-falls-as-weight-rises` validation finding, and
can be switched off via `checkMonotonicPricing` if the drop is a deliberate volume incentive.

## Deployment

Containerised and verified running as a container against a real database. See
[`docs/deploy-aws.md`](docs/deploy-aws.md) for the full AWS walkthrough.

```bash
docker build -t dns-pricing .        # 341 MB, non-root, no secrets in the image
docker build --target tools -t dns-pricing-tools .   # for one-off seed jobs
```

Runtime environment: `MONGODB_URI`, `MONGODB_DB`, `SESSION_SECRET`, `BOOKING_API_KEY`.
Load-balancer health check: `GET /api/health` (pings Mongo, unauthenticated).

`SESSION_SECRET` must be identical across instances — it signs the session cookie, so a
per-instance value would reject cookies issued by another task.

## Still to do

- **Confirm the AWS shape** — ECS Fargate is recommended in the deployment doc; match the
  existing site's platform if it already has one.
- Pincode CSV import with diff preview (the search and export path exists; the import writer
  does not).
- Email or Slack notification when a request is waiting. The in-app queue works.
- FTL and over-1000 kg pricing, which the source marks as quoted separately.
- Per-customer overrides of cartage, ODA and charge parameters. The storage model already
  supports any bind path; only lane rates are exposed in the contract editor so far.
- Contract validity dates. Contracts currently take effect on approval and do not expire.
