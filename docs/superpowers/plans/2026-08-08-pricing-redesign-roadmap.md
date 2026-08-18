# Pricing config redesign — roadmap

> Source: `DNS_Pricing_App_Redesign_Mockup.html`, 14 parts. This document maps every part
> to what exists, sequences the build, and records the decisions that must be taken before
> the parts that depend on them. Nothing in the mockup is dropped; where a part is already
> built or partly built, that is stated rather than rebuilt.

Companion plan: `2026-08-08-phase-1-smart-geography.md` (Part 4, full task detail).

---

## Three findings from reading the mockup against this codebase

### 1. The city data question is answered — the data is already here

Part 4 is built on city as a first-class level, and city has been the blocking question in
`2026-08-08-lane-granularity-design.md` since it was written: the pincode master holds
`area` (a post office) and `state`, but no city.

**Every one of the 19,494 pincodes carries `bluedart.district`, and there are 747 distinct
values.** That is option (a) in the spec's question 1 — "derive from the district field the
Bluedart import carries" — and it is fully populated, not partially. Part 4 is unblocked.

Two honest caveats, because district is not exactly city:

- **District merges the mockup's own example.** `411017` (Pimpri Colony) and `411019`
  (Chinchwad East) both carry district `Pune`. The mockup lists "Pune · 12 pincodes" and
  "Pimpri-Chinchwad · 6 pincodes" as separate cities. On district they are one city of 18.
- **Names differ.** `560001` is district `Bengaluru Urban`; the mockup says `Bangalore`.

Both are display-layer problems, not model problems: the `city` endpoint kind matches on a
string, so a curated alias/split table can refine district into city later without touching
the matcher. Phase 1 ships district-as-city and a named-alias table seeded with the handful
the mockup names.

### 2. Part 3's diagnosis does not hold for this repo — but the number is real

The mockup says restricting mode coverage "silently snapshots the entire lane matrix," and
attributes Kirloskar's 1,681 cells to it. In this codebase coverage restriction does no such
thing: `ContractScope` holds `modes` and `lanes` as nullable lists (`src/customers/contract.ts:164`),
and restricting a mode writes no cells at all.

The 1,682 cells are real, and the cause is simpler: **there is only one way to store a rate —
one override cell per lane per rate key.** A zone-group edit across West (7 zones × 4 rates)
*must* expand to 28 cells, because nothing else can be stored. 21×21 lanes × 4 rates is 1,764.

This matters for sequencing: **Part 3 and Part 4 are the same fix.** "Stored as 4 deltas, not
28 cells" is not a rate-builder feature, it is rule storage. Part 3 becomes the authoring UI
over Part 4's model. Building Part 3 first would mean building it twice.

The mockup's amber callout — an explicit `Lock today's prices on every other lane too`
checkbox — is still worth having, but it describes a feature this system does not currently
have rather than a bug it currently has. It is planned as a feature in Phase 2.

### 3. Part 5 answers a question that was blocking rule storage

Rules need a **reviewable identity**: the approval diff walks `EDITABLE_SHEET_SPECS` and reports
a change only if it renders at a fixed A1 address (`src/changes/diff.ts:46-70`), so a
variable-length rule list would price correctly and be invisible to approvals.

Part 5 settles it. "4 decisions instead of 1,681 rows" means **the rule is the unit of review.**
A rule gets a stable id and is diffed as a rule, not decomposed into cells. That is the
synthetic-bind-path option, and the mockup independently arrives at it — which is good evidence
it is right. Phase 1 builds rule identity; Phase 2 builds the grouped approval UI on it.

---

## Part-by-part status

Updated 9 Aug 2026. Every part of the mockup is now built or explicitly accounted for.

| # | Mockup part | State | Phase |
|---|---|---|---|
| 4 | **Smart geography** | **Built.** Endpoints, specificity, tie rules, district-as-city, rule storage by id, rules priced at quote time with grid fallback, search, coverage preview, cascade, shipment tester, console screen. | 1 ✅ |
| 5 | **Approvals grouped by intent** | **Built.** Rules reach the diff; proposals group by rule / mode+region / tab, each heading carrying lanes touched and steepest cut. | 2 ✅ |
| 3 | **Rate builder** | **Built.** Lane-by-lane preview, "one rule not N cells", and the `Lock today's prices on every other lane too` decision as an explicit act with its own review line. Bulk changes now names the case where a rule would say it better. | 2 ✅ |
| 9 | **Extra & ad-hoc charges** | **Built.** `chargeLibrary` derives every defined charge with usage counts; `/charges` lists them; `NewChargeForm` defines one, saved inactive at zero. Outstanding: attaching a one-off at booking time, which needs a booking screen that does not exist. | 2 ✅ |
| 2 | **Templates** | **Built.** Gallery with usage counts, parameter-vs-fixed marking, fit scoring and named conflicts at assignment, provenance both directions. | 3 ✅ |
| 6 | **Products** | **Built.** Catalog, per-product detail, customer segment tags, apply to one customer or a whole segment with per-customer results. | 3 ✅ |
| 1 | **Customer creation wizard** | **Built.** Four steps, live code check, template/clone/blank start, coverage, review — plus the escape hatch to change code or base card before the first negotiated cell. | 3 ✅ |
| 10 | **Online signups** | **Built.** `POST /api/signups`, a review queue, segment-based suggestion rules with a manual-review threshold, activation onto a product. | 4 ✅ |
| 7 | **Festival & offers** | **Built.** Time-boxed adjustments resolved at quote time, applied before settlement so fuel follows, non-stacking with the passed-over offer recorded, named on every quote they touch. | 4 ✅ |
| 8 | **Co-loaders** | **Built, bar routing.** Buy tariffs surfaced as named co-loaders with margin across every customer on the lane. Lane-to-vendor priority deliberately not built — see below. | 4 ✅ |
| 11 | **Wallet & credit** | **Built as views.** Ageing buckets added to the ledger; `/money` reads wallets, credit and invoices from the one replay. | 5 ✅ |
| 12 | **Billing** | **Built as views.** Same screen; invoices already existed, one per mode with deterministic numbers. Cadence and auto-drafts need a scheduler this service does not have. | 5 ✅ |
| 13 | **Navigation shell** | **Built.** Regrouped into Customers / Contracts / Approvals / Money / Tools. Nothing removed. | 5 ✅ |
| 14 | **What changed** | Documentation. Folded into this roadmap. | — |

### Three things deliberately not built, and why

- **Lane-to-vendor priority** (Part 8's second half). Booking-time routing, and this system
  does none — there is no booking screen for it to act on. A table of preferences nothing
  reads is worse than an absent feature: it looks like a decision that is in force.
- **A one-off charge attached at a booking** (Part 9). Same reason. The library already marks
  which charges *could* be, and refuses the ones with no single amount to ask for.
- **Invoice cadence with automatic drafts** (Part 12). Needs something running on a schedule.
  A stored cadence with nothing acting on it reads as a promise the system is not keeping.

### One policy question left open

The engine refuses a booking while anything is overdue. Part 11 says the block should trigger
only on a limit breach, and calls that how it is decided today. Both are defensible and they
are different rules; it is left as the engine has it and flagged on `/money`, because loosening
a funds gate on the strength of a caption is not a change to make quietly.

### Defects found while building, and fixed

1. **Phase 2** — `diffCardData` walks sheet specs, and a rule lives at no A1 address, so a rule
   added to a draft produced zero review lines. Closed in `src/changes/rule-diff.ts`.
2. **Phase 5** — contract overrides were pruned against the bare base card. Once a card moved,
   every price-locked rate would have returned as a negotiated cell: a promise not to drift,
   coming back as thousands of bargained lines. Pruning is now against card-plus-lock.
3. **Phase 5** — rejecting a proposal with no rate lines *approved* it. The outcome was decided
   by counting approved and rejected lines, and a coverage-only proposal has neither, so
   "reject all" came out `approved` and applied the coverage it was refusing.
4. **Phase 5** — `applyProposalDecision` rebuilt terms from the cells it knew how to judge, so
   contract lane rules and price locks were dropped on approval. Nothing writes contract rules
   yet, so nothing had been lost.

Anyone extending storage should take the lesson generally: **if it can change a price, prove it
reaches `diffCardData` with a test** — and if it cannot reach the cell diff at all, give it its
own review line, as the price lock has.

## Sequencing, and why

**Phase 1 — Smart geography (Part 4).** Everything else in the mockup assumes "one rule, many
lanes." Parts 1, 2, 3, 5 and 6 all display or author rules. Building any of them on the current
cell model means rebuilding them. Phase 1 also delivers rule identity, which unblocks Part 5.

**Phase 2 — Authoring and review (Parts 3, 5, 9).** The rate builder rewritten onto rules, the
approval queue grouped by rule, and the charge library. These are the screens a pricing person
uses daily, and they are the ones the 1,682-cell problem actually hurts.

**Phase 3 — Packaging (Parts 2, 6, 1).** Templates gain parameters, Products bundle template +
coverage + charges, and the customer wizard consumes both. Ordered this way because the wizard's
step 2 offers a template or a product, so both must exist first.

**Phase 4 — New surfaces (Parts 10, 7, 8).** Signups consume Products. Offers add a resolution
layer on top of Phase 1's resolver. Co-loaders extend the existing cost/margin model.

**Phase 5 — Money and shell (Parts 11, 12, 13).** Reconciling the existing billing engine with
the mockup's wallet/credit/invoice screens, then the navigation regroup once the page set is
final. Nav last, deliberately: regrouping a menu before the pages settle means doing it twice.

---

## Decisions needed before the phase that needs them

| # | Decision | Blocks | Default if unanswered |
|---|---|---|---|
| D1 | ~~District-as-city.~~ **Revised 9 Aug** after running the app: district `Pune` is **149** pincodes, not the ~18 estimated — Bangalore is 114 against a mockup expecting 9. The level is now labelled **district** everywhere a person reads it. A curated city split is still wanted before city rules are used in anger. | Phase 3 | Labelled honestly; curate splits when a real city rule is needed. |
| D2 | ~~Does a rule carry **effective dates**?~~ **Settled 9 Aug:** rules stay undated and offers carry the time axis, as planned. An offer is resolved at quote time and never written into a contract, so a dated rule would be a second way to express the same thing — with the difference that it would need cleaning up afterwards. | — | Done. |
| D3 | ~~Product naming.~~ **Settled 9 Aug:** the card field is now `source`, normalised on read with no migration; `product` is free. | — | Done. |
| D4 | ~~Wallet/credit/billing: drive the engine or replace it?~~ **Settled 9 Aug: driven.** `/money` reads wallets, credit ageing and invoices from the one ledger. One policy difference is flagged rather than resolved — see above. | — | Done. |
| D5 | **Per-plant rate overrides** — mockup Part 14 flags this as needing a data-model change, and the lane spec §4 says settling the layer rule makes it a fourth layer rather than a second design. | Phase 3 | Fourth layer under contract, once Phase 1's layer model is proven. |

D5 is the only one still open. Per-plant rate overrides were not needed by any part built
here, and the layer model they would extend is now proven — a fourth layer under contract
remains the right shape when somebody asks for it.

---

## What is explicitly not being rebuilt

The mockup grants permission to remove or redesign anything. These are kept, because they are
verified against real workbooks and real signed contracts, and the mockup does not contradict
them:

- The three freight models and the 150 golden fixtures. Part 6 explicitly reuses "the same
  Model 1 cumulative-slab engine."
- The settlement engine — fuel base, charge menu, per-mode tax with SAC/RCM/ITC.
- The billing ledger, invoices and funds gating (see D4).
- Sparse overrides and `null` meaning "not carried" — Part 4 depends on both.
- The Excel sheet view. The mockup neither shows nor removes it; it is the fallback for people
  who work in A1 addresses, and rules will need a representation there (Phase 2).
