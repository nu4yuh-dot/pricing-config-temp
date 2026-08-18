# Lane granularity — city, state and zone overrides

Today a rate is stored against one shape: `zone → zone`. The ask is to price
`city → city`, `city → zone`, `state → state`, `city → state` and the rest, with **the most
specific matching rule winning**.

This is the largest change proposed to the engine so far. It alters how *every* quote
resolves a lane, and production carries 11 live contracts — SEIMITSU 1,662 negotiated
cells, KIRLOSKAR 1,682 — so it is written down before it is built.

---

## 1. What exists now

A pincode resolves to a zone per mode, and a rate is read at `grids.<mode>.<grid>.<origin
zone>.<destination zone>`. One lookup, no ambiguity, and a contract override is the same
path with a customer's value on top.

Two properties are worth keeping:

- **Sparse overrides.** A contract stores only what differs, so it keeps tracking the base
  card everywhere it has not negotiated.
- **`null` means "not carried".** It is a value, not an absence, and closing a lane is a
  different act from pricing it high.

## 2. The shape of a rule

A rate becomes a **rule** with an endpoint at each end. An endpoint is a kind and a value:

| Kind | Value | Matches |
|---|---|---|
| `pincode` | `411001` | that pincode |
| `city` | `Pune` | every pincode whose city is Pune |
| `zone` | `PNQ` | every pincode in that zone, per mode |
| `state` | `Maharashtra` | every pincode in that state |
| `group` | `metros` | the named zone group |
| `any` | — | anything |

A rule is `{ mode, origin: Endpoint, destination: Endpoint, rates: LaneRates }`. The
existing zone × zone grid is exactly the case where both endpoints are `zone`, which is
what makes migration a no-op rather than a rewrite.

**City is not held today.** The pincode master has `area` and `state`, and `area` is a post
office, not a city — 300 areas in Maharashtra alone. A `city` endpoint needs a city field
on the pincode master first. That is a data question, and it is question 1 below.

## 3. Matching: most specific wins

Each endpoint kind carries a specificity, and a rule's specificity is the pair:

```
pincode 5 · city 4 · zone 3 · state 2 · group 1 · any 0
```

Resolution: collect every rule matching the shipment's mode, origin and destination pincode;
sort by `origin specificity + destination specificity` descending; take the first.

Ties break in this order, each rule stated so two rules can never silently disagree:

1. **Higher origin specificity wins.** `city → zone` beats `zone → city`. Arbitrary but
   fixed; without it the pair sums tie and the answer depends on storage order.
2. **A contract rule beats a base-card rule of equal specificity.** Negotiating is the act
   of overriding.
3. **The more recently edited wins**, and the quote says so, because at that point the two
   rules are genuinely equivalent and somebody should collapse them.

### The decision that is not obvious

**Does a specific *standard* rule beat a general *negotiated* one?**

A customer negotiates `zone PNQ → zone NCR` at ₹12/kg. The base card later gains a
standard `city Pune → city Delhi` rule at ₹15/kg. On pure specificity the standard rule
wins and the customer loses their negotiated price without anyone touching their contract.

**Proposed: no.** Contract rules are matched first as a complete set; the base card is only
consulted when no contract rule matches at all. Specificity orders rules *within* a layer,
never across them. A negotiated price should never be displaced by an edit somebody made to
the standard card.

## 4. What a quote shows

A quote must name the rule it used — `Pune → NCR · city → zone · contract` — because with
six endpoint kinds "why is this price what it is" stops being answerable by looking at one
cell. The resolution trace already exists as an idea in the gap analysis (§2.3); this is
what makes it necessary rather than nice.

## 5. Storage

Rules live beside the grids rather than replacing them:

```
grids.<mode>.<grid>.<origin>.<destination>   unchanged — the zone × zone case
laneRules[]                                  everything else
```

Two reasons. The grids are what the Excel sheets render at fixed A1 addresses, and 1,682
existing override paths keep working untouched. A rule list is additive, and a card with no
rules behaves exactly as it does today.

## 6. Cost

Every quote currently does one lookup. With rules it scans the rule list. Fine at tens of
rules, not at thousands — SEIMITSU-scale contracts would be felt. Rules are indexed by mode
and by each endpoint value at load, so a quote examines only candidates, never the whole set.

## 7. Order of work

1. City on the pincode master (blocked on question 1)
2. `Endpoint`, specificity, and the matcher — pure, unit-tested against the tie rules above
3. Resolution trace on the quote
4. Rule storage and the editor
5. Migration: none. Existing grids are the `zone → zone` case and keep working.

The golden fixtures must stay green throughout: with no rules defined, every quote must
resolve exactly as it does today.

---

## Questions before building

1. **Where does "city" come from?** The master has `area` (post office) and `state`, not
   city. Options: derive from the district field the Bluedart import carries, buy or import
   a pincode→city dataset, or treat "city" as a named group of pincodes maintained here.
   This blocks the whole feature.
2. **Is the layer rule right?** Contract rules beat base rules regardless of specificity
   (§3). It protects negotiated prices; it also means a very specific standard rule will not
   apply to a customer with any matching negotiated rule.
3. **Should a rule carry effective dates?** Contract lifecycle is already an open gap. If
   rules are dated, that gap closes here rather than separately.
4. **Per-plant pricing** is the same problem one layer down: a plant is an origin more
   specific than its customer. Settle §3 and per-plant becomes a fourth layer rather than a
   second design.
