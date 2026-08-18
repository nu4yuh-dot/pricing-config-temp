# Gap analysis — `dns-pricing-engine_3.html` against the built system

Every concept in the mockup, and where it stands. Nothing omitted.

## Status as of this pass

Items 1.1, 1.2, 1.3, 1.4 and 1.8 are **now built**, with 62 new tests, and the 150 golden
fixtures still match the workbooks to the paisa. What that means concretely:

| Was | Now |
|---|---|
| One GST rate per air/surface, no SAC, no RCM by mode | `Tax & Charges` tab: SAC, rate, reverse charge and ITC for each of surface, air, rail, NFO, FTL, courier |
| Fuel hardcoded onto freight + cartage + ODA | The base is five switches, including "other charges" — A Raymond's 35% on total is expressible |
| One `docket` number | A charge menu: per shipment / per AWB / per kg / from pincode distance / per destination zone, each with its own GST and fuel treatment, on/off, and mode restriction |
| ESS not representable | `per-destination` basis, amounts held per zone |
| No cost basis at all | `data.cost` buy tariff, margin on every quote, thin/loss warnings, `checkLaneMargin` sweeping weights |

Two things worth knowing about how it was done:

- The configuration is **cells on a tab**, not a settings screen. Everything in this system is
  edited, diffed and approved as a cell; a GST rate living outside that machinery could have gone
  live unreviewed. Five tests in `src/changes/diff.test.ts` prove a tax or charge edit reaches the
  approval diff, and fail if the tab is ever unregistered.
- A card that declares nothing behaves **exactly** as before — the workbook fuel base, the
  workbook rate at forward charge, the docket as the only active charge. That is why no verified
  number moved. The statutory defaults (road at 5% RCM) apply only once a card asks for them.

Also fixed along the way: `settle()` accepted an ODA figure, put it in the fuel base, and then
never billed it. ODA now enters the taxable value, and is billed once whether it arrives as a
figure or as a `by-pincode` charge.

### Since then

**FTL is built** (§2.1's blocker, in part). Nine vehicles, a price per vehicle per lane, its own
tab, its own console editor, and `GET /api/quote/ftl`. It is deliberately not routed through the
partload engine: a truck is hired whole, so there is no chargeable weight to invent. Everything
after freight is shared — same fuel base, same charge menu, FTL's own 12% with ITC.

**Billing is built** (§3.4–3.8, which came back into scope). An append-only ledger in integer
paise, credit positions computed by replay rather than stored, invoices one-per-mode with
deterministic numbers, and bookings gated on funds — `/api/quote` now returns 402 when the price is
agreed but the money is not. 51 unit tests plus 13 checks against a real database in
`scripts/verify-billing.ts`.

Two defects were found and fixed while building it, both by reasoning rather than by a failing
test: `settle()` accepted an ODA figure and never billed it, and a payment keyed on the invoice
number meant a second part payment was silently swallowed as a duplicate.

### The signed rate cards contradict the mockup deck

17 customer rate cards were shared (`~/Downloads/Rate card images`). Read against them, the
figures in `dns-pricing-engine_3.html` — which everything here was originally keyed from —
are **wrong for MAHLE**:

| MAHLE air | Mockup deck | Annexure 2 (signed) |
|---|---|---|
| 1–25 kg | ₹4,500 | ₹4,500 ✓ |
| 26–50 kg | ₹5,200 | **₹4,800** |
| 51 kg and above | ₹80/kg | **₹75/kg** |
| East / Kolkata | ₹5,800 / ₹7,000 / ₹90 | **₹5,500 / ₹6,500 / ₹86.5** |

`real-contracts.test.ts` has been corrected to the signed card. On a 100 kg air shipment the
deck's numbers over-quoted by ₹649 landed.

Two things the signed card adds that the deck omitted entirely:

- **Volumetric divisors differ by mode**: air is `L×B×H / 5000`, surface is `/ 4000`. The
  deck gave only the air one.
- **Real FTL rates**: Chennai→Ennore is ₹4,500 per trip by Tata Ace and ₹5,800 by pickup —
  per vehicle, per lane, exactly the shape the FTL engine takes.

**A Raymond is confirmed correct** as keyed, including "35% on **Total** Charges" in writing,
₹4,500 minimum at 50 kg then ₹80/kg, ₹1,000 P&D per consignment, and the ESS table. One
addition: their **bus** mode carries no fuel surcharge at all (the card says NA).

The 1–25 kg band question stands and is now confirmed to be real: the card lists it *and*
sets a 50 kg minimum chargeable weight, so on any reading where the minimum applies first,
that band cannot be reached. Only MAHLE can settle it.

**Bluedart is built** (§2.1's other blocker). Its rate card arrived as
`DNS_Directional_RateCard_Calculator.xlsx` and is now a product in its own right: a `product` field
on the card, its own tab, its own console page, its own calculator and `GET /api/quote/bluedart`.
127 golden fixtures from the workbook's own Calculator, matched exactly.

Three data findings came out of loading it, all reported rather than quietly absorbed:

1. **Pincode 334002 (NDC Bikaner)** is labelled Chhattisgarh in *both* pincode masters while every
   other 3340xx pincode is Rajasthan. That puts it in WEST, the cheapest zone, instead of NORTH —
   ₹417.50 against ₹442.50 on a 30 kg surface shipment, before fuel and GST. **Left as the source
   has it, by decision**, and flagged here.
2. **Three corrupted area names** in the DNS source workbook — `air partnerpet`, `I.E.air
   partnerpet`, `air partnernagar SO Bardhaman` — are Suryapet, I.E.Suryapet and Suryanagar SO
   Bardhaman with `Surya` replaced by `air partner`, a find-and-replace that caught three post
   offices. The franchise workbook has them intact and is used as the second source. Display only;
   no price depends on an area name.
3. **The workbook's own Calculator bills ₹354 for a pincode it cannot find** — nil freight, but AWB,
   FOV and GST charged anyway. The engine refuses instead.

Still open from §1: 1.5 and 1.6 (per-customer minimum weight and volumetric divisor — both are
override paths, so they are small), 1.7 (P&D at customer × lane grain). From §2: products as an
entity distinct from pricing model, the branch layer, resolution trace, assignment scope, effective
dates and contract lifecycle. From §3: the reconciliation engine, the four-role split, and the
desks. Nothing in §4 has moved.

## Legend

- **Built** — exists and is deployed
- **Partial** — exists but cannot represent what the mockup/real contracts need
- **Gap** — not present
- **Conflict** — contradicts a decision already taken

---

## 1. Correctness gaps — the engine cannot price your real customers

These are not features. They are places where the engine would produce a **wrong number**
for MAHLE or A Raymond as those contracts actually stand.

| # | Concept | Status | Why it matters |
|---|---|---|---|
| 1.1 | **Mode-wise GST** — Surface 5% RCM, Air 18% forward, Rail 5%, FTL 12%, Courier 18%, each with SAC code and ITC flag | **Partial** | Built system has only `gstAir` / `gstSurface`, no SAC, no per-mode RCM, no ITC, no Courier or FTL. RCM is per-customer, but in law it is a property of the **mode** (GTA road). A surface leg for a customer marked forward-charge is still 5% RCM. |
| 1.2 | **Configurable fuel base** | **Partial** | Built system hardcodes fuel onto freight + cartage + ODA. **A Raymond's contract is 35% on TOTAL charges.** The engine cannot express that, so it under-quotes them. |
| 1.3 | **Charge catalog** — docket, AWB, handling, green tax, ODA — each with basis, amount, *GST applies?*, *fuel applies?*, on/off | **Gap** | Built system has a single `docket` number. MAHLE has green tax; A Raymond has ESS. Neither is representable. |
| 1.4 | **ESS / per-destination express surcharges** | **Gap** | A Raymond has nine of them (Bangalore-Mysore ₹3,000, Pantnagar express ₹9,000 …). No model for a charge that varies by destination. |
| 1.5 | **Per-customer minimum chargeable weight** | **Partial** | Min weight is per mode on the card (25 air / 50 surface). MAHLE contracts **50 air / 100 surface**. A customer cannot currently override it — but it is an override path, so this is small. |
| 1.6 | **Per-customer volumetric divisor** | **Partial** | Same: exists on the card, overridable in principle, not surfaced. |
| 1.7 | **P&D per customer × per lane** | **Partial** | Built P&D is per **zone** on the card, overridable per customer. The mockup's grain is customer × lane, with fallback to a customer default. MAHLE is flat ₹2,000/₹3,000 by mode; A Raymond ₹1,000 per consignment. Representable but awkward. |
| 1.8 | **Buy cost and margin guardrail** | **Gap** | No cost basis anywhere. Cannot compute margin, cannot flag a loss-making lane at approval, cannot reconcile. This is the single biggest missing idea. |

## 2. Structural gaps — the layering model

| # | Concept | Status | Note |
|---|---|---|---|
| 2.1 | **Product as a first-class entity** — DNS Surface, DNS Air, DNS Rail, NFO, Bluedart, FTL; each declares a model + lane matrix + default charges + cost basis + effective dates | **Gap / naming conflict** | The built system's three "rate cards" are **pricing *methods*** (cumulative / min+excess / max), not products. The mockup's products each *pick* a model. These are orthogonal axes that the built system currently conflates. Fixing this is a real restructure and is the prerequisite for Bluedart and FTL. |
| 2.2 | **Four resolution layers** base → product → contract → branch | **Partial** | Built: base card → customer overrides (two layers). Missing the product layer and **branch overrides** entirely. |
| 2.3 | **Resolution trace** — which layer supplied each field | **Gap** | The sparse-override model already knows this; it is simply never shown. Cheap to add and genuinely useful. |
| 2.4 | **Effective dates / contract lifecycle** Draft → Proposal → Active → Expiring → Renewed, T-30 reminder | **Gap** | Contracts take effect on approval and never expire. Already flagged as missing. |
| 2.5 | **Assignment scope** — Global / branch / city / operator; a price is only bookable inside its scope | **Gap** | No notion of branch, city or operator. Contract *coverage* (modes/lanes/weights) exists, which is a different axis. |
| 2.6 | **Cloning a product** | **Partial** | Templates do this for contracts, not products. |

## 3. Operational gaps

| # | Concept | Status | Note |
|---|---|---|---|
| 3.1 | **Reconciliation engine** — upload coloader bill, match each line to its consignment note, check billed weight vs CN, buy cost vs tariff, and per-docket profitability; flag up-billing → debit note; loss-makers → pricing | **Gap** | Depends entirely on 1.8 (buy cost). Admin-only in the mockup, correctly — it exposes buy costs. |
| 3.2 | **Four roles** Editor / Approver / Admin / Viewer | **Partial** | Built has three: configurator / admin / viewer. The mockup separates *approver* from *admin*, which matters: an approver approves prices but should not see buy costs or touch money. |
| 3.3 | **Three desks** — Pricing (never touches money), Accounts (never edits a rate), Operator (books only, zero config) | **Gap** | This is a permissions model, and a good one. Partially expressible with the existing capability list. |
| 3.4 | **Two account archetypes** — Retail self-signup (prepaid, rack rates, auto-suspend at ₹0) vs Enterprise (credit limit + days) | **Gap** | No signup path, no rack-rate price book, no prepaid concept. |
| 3.5 | **Rack-rate price book** shown to self-signups, priced above the enterprise floor | **Gap** | Genuinely good idea — removes "what do we quote this new person", and makes every discount a deliberate approved contract. |
| 3.6 | **Wallet** — recharge, booking *hold*, settlement at actuals on delivery, reweigh adjustment, refund needing Admin approval | **Conflict** | See §5. |
| 3.7 | **Credit position** — limit, utilisation, credit days, ageing, auto-hold on over-limit or overdue | **Conflict** | See §5. |
| 3.8 | **Invoices, one per mode** | **Conflict / important insight** | See §5. |

## 4. Presentation gaps

| # | Concept | Status |
|---|---|---|
| 4.1 | **Explain mode** — a global toggle showing "how it works" panels inline | **Gap.** The built system has a glossary page; the mockup puts the explanation *at the control*. The mockup's approach is better. |
| 4.2 | **Model comparison with a weight slider** | **Partial** — the calculator prices all three cards side by side, but there is no slider sweeping weight, and no "cheapest" marker. |
| 4.3 | **Serviceability reasons** — "beyond 30 km", "no agent · on request only" | **Gap.** Built shows served/not-served but never *why*. |
| 4.4 | **City → pincode navigation** | **Partial** — built browses state → area, because the master has no city column. The mockup assumes a city. |
| 4.5 | **Margin panel beside the lane editor** | **Gap** — depends on 1.8. |
| 4.6 | **Customer-360 snapshot** | **Gap** |

## 5. Conflict with a decision already taken

The mockup contains three money tabs — **Accounts & wallets**, **Billing & wallet**,
**Reconciliation** — and earlier the instruction was explicit: *"Billing — wallet, credit terms,
recharge, invoices → out of scope here, samex.delivery owns it."*

Two of those three are genuinely billing and remain out of scope on that decision. But one is
not, and I want to separate them:

- **Wallets, recharges, invoices, credit ledgers** → billing. Still out of scope unless the
  decision changes.
- **Reconciliation** → *not* billing. It compares a coloader's bill against consignment notes
  and computes per-docket profitability, then feeds loss-making lanes back into pricing. That
  is a pricing function, and it is arguably the most valuable single tab in the mockup.

**One insight from the billing tabs is worth keeping regardless of who builds it:** because GST
differs by mode, a single invoice cannot carry a Surface leg (5% RCM) and an Air leg (18%). The
engine must therefore be able to **group charges by mode and report them separately**, whoever
raises the document. That is a pricing-side requirement, not a billing one.

## 6. Real customer data in the mockup

The mockup contains actual contracted figures, which are the best test data available:

**MAHLE Anand Thermal Systems** — GSTIN `27AABCB2186L1ZI`, Chakan/Pune, onboarded 01 Dec 2025,
credit 45 days. Surface PTL lane-wise (Chennai→Pune ₹8/kg, →Hosur ₹6, →Pitampur ₹10,
Pune→Noida ₹9, Noida→plants ₹10, express ₹13). Air all-metros slabs (1–25 kg ₹4,500 / 26–50
₹5,200 / 51+ ₹80·kg; East ₹5,800 / ₹7,000 / ₹90·kg). Train ₹22 N/W/S, ₹28 East. FTL at
actuals. P&D ₹2,000 surface / ₹3,000 air. Docket ₹100. Fuel 10%. Min weight 50 air / 100
surface. Volumetric /5000. Green tax as applicable. Insurance by MATS.

**A Raymond** — Chakan, PAN-India. Air min 50 kg ₹4,500 then ₹80/kg. Bus min 100 kg ₹25/kg.
Train ₹20 metros / ₹25 East-Assam. FTL Pune→Blr ₹33k, →Chennai ₹38k, Navsari→Pune ₹19–30k.
**Fuel 35% on total.** P&D ₹1,000 per consignment. Nine ESS surcharges. ~30 days, RTGS only.

**Cards on file, not yet keyed:** Bavaria, Fibro, Kirloskar Brothers, Seimitsu, SKS Welding,
Milenium.

### Resolved: no fourth freight model is needed

Both contracts are now expressed in existing fields and verified end to end in
`src/customers/real-contracts.test.ts` (14 tests). What they needed was not a new formula but
the *right existing* formula, which is a property of the base card a contract is written
against:

| Customer | Contract shape | Formula | Card |
|---|---|---|---|
| MAHLE | flat ₹/kg by lane, with a weight floor | `MAX_MIN_OR_FULL` — minimum charge 0 reduces it to rate × weight | `model-3` |
| A Raymond | minimum 50 kg ₹4,500, then ₹80/kg on the excess | `MIN_PLUS_EXCESS` | `model-2` |

MAHLE's surface is exact: ₹8/kg Chennai→Pune gives ₹1,600 at 200 kg and floors at ₹800 for
anything under their contracted 100 kg surface minimum. A Raymond is exact throughout, including
35% fuel on total (₹4,410 on a 100 kg Pune→Bangalore shipment) and the ₹3,000 Bangalore ESS. Their
landed total comes to ₹20,071.80.

**One question only MAHLE can settle.** Their air card lists three bands — 1–25 kg ₹4,500, 26–50
₹5,200, 51+ ₹80/kg — *and* sets the air minimum chargeable weight at 50 kg. A 20 kg shipment is
therefore billed as 50 kg, which lands in the second band, so the ₹4,500 band cannot be reached.
Either it is superseded by the 50 kg minimum (how it is keyed — this never undercharges), or the
real minimum is 25 kg with a step at 26 kg, which is a *second* flat band and no rate card in this
system or in the source workbooks has two. Worth ₹700 on every air shipment under 25 kg.

---

## Implementation order

**Now (this pass)** — the correctness gaps, because the engine currently produces wrong numbers:

1. Mode tax profiles: SAC, GST rate, RCM, ITC per mode (1.1)
2. Configurable fuel base, including "on total" (1.2)
3. Charge catalog with per-charge GST and fuel treatment (1.3, 1.4)
4. Charges grouped by mode in the result, for the one-invoice-per-mode rule (§5)

**Next** — the biggest missing idea:

5. Buy cost on lanes, margin computation, approval flagging below a floor (1.8)
6. Reconciliation against consignment notes (3.1)

**Then** — structural, needs a decision because it is a restructure:

7. Product as an entity distinct from pricing model (2.1), which unblocks Bluedart and FTL
8. Branch layer and resolution trace (2.2, 2.3)
9. Assignment scope (2.5)
10. Effective dates and contract lifecycle (2.4)

**Needs a decision from you:**

- Does the wallet/credit/invoice material (3.4–3.8) come back into scope, or stay with
  samex.delivery? The mockup says yes, your earlier instruction said no.
- MAHLE's band-price air model is a fourth freight model. Confirm the intent before I build it.
- Approver as a role distinct from Admin (3.2)?
