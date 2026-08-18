# Integrating with infracharge-app (samex.delivery)

Read-only analysis of `github.com/Akhpie/infracharge-app` against this pricing service.
**Nothing in that repository was changed, and nothing in it should be.** Where a change is
unavoidable on their side it is called out explicitly and kept as small as possible.

Analysed at clone depth 1 on 2026-08-07: `server/src/model/*`, `server/src/routes/*`,
`server/src/services/pricingService.ts`, `.env.example`.

---

## 1. Where the two systems stand today

infracharge prices shipments itself, in `services/pricingService.ts`:

```
price = baseRate + weight×weightFactor + distance×distanceFactor + volume×volumeFactor
```

`distance` is a rough estimate and the comment says to replace it with a real distance API.
There is **no call to any external pricing service anywhere in the repo** — no
`PRICING_URL`, no `x-api-key`, nothing. So this integration is greenfield: their code does
not currently break, it simply does not call us yet.

That matters for the question "what has to change so requests do not crash": nothing crashes
today. The list below is what has to line up *before* the first call is made.

---

## 2. Blocking mismatches

These produce a wrong answer or a hard failure. Ordered by how badly they bite.

### 2.1 Vehicle types do not overlap — every FTL quote fails

| infracharge `vehicleType` | This service | Status |
|---|---|---|
| `TATA_ACE` | `TATA_ACE` | ✅ matches |
| `TRUCK_19FT` | `19FT` | ❌ different string |
| `TRUCK_24FT` | — | ❌ **no equivalent** |
| `TRUCK_32FT` | `32FT_SXL` (9 t) or `32FT_MXL` (15 t) | ❌ **ambiguous** |
| `TATA_SUPER_ACE` | `8FT` (1.5 t)? | ❌ needs a decision |
| `BOLERO_PICKUP` | `8FT` (1.5 t)? | ❌ needs a decision |

`GET /api/quote/ftl?vehicle=TRUCK_19FT` returns `unknown-vehicle` today. Every FTL quote
fails until this is resolved.

**Fix without touching their repo:** we add an alias table so their strings resolve. Two need
a business answer first: is `TRUCK_32FT` single- or multi-axle, and do `TATA_SUPER_ACE` and
`BOLERO_PICKUP` both map to the 1.5 t pickup? A 32 ft SXL carries 9 t and an MXL carries 15 t
— guessing means quoting the wrong truck.

### 2.2 `transportMode` collides across two products

Their enum has 16 values; ours are split across three endpoints.

| infracharge `transportMode` | Endpoint | `mode` / `service` |
|---|---|---|
| `PTL_NORMAL`, `PTL_EXPRESS` | `/api/quote` | `surface` |
| `AIR_CONSOLE`, `AIR_DIRECT` | `/api/quote` | `air` |
| `AIR_NFO` | `/api/quote` | `nfo` |
| `RAIL` | `/api/quote` | `rail` |
| `FTL` | `/api/quote/ftl` | + `vehicle` |
| `APEX` | `/api/quote/bluedart` | `APEX` |
| `SURFACE` | `/api/quote/bluedart` | `SURFACE` |
| `DART_PLUS`, `VELOSKY`, `VELOFREIGHT`, `VELODOC`, `DOMESTIC_PRIORITY` | — | ❓ **unmapped** |
| `BUS`, `HAND_CARRY` | — | ❓ **not priced here** |

**The dangerous one:** their `SURFACE` and `APEX` are Bluedart service names, but our
`/api/quote?mode=surface` means *DNS* surface. Same word, two products, different prices. A
router that keys on the string alone will quote DNS rates for a Bluedart booking and nobody
will notice, because both return a plausible number.

The five Bluedart-family values (`DART_PLUS`, `VELOSKY`, `VELOFREIGHT`, `VELODOC`,
`DOMESTIC_PRIORITY`) are not on the franchise rate card at all — that card carries DOCs,
DUTS, APEX and SURFACE only. Either they are out of scope, or the rate card is incomplete.
**Needs an answer before go-live.**

### 2.3 Pincode is a string there and a number here

Their `pincode` is `String` in `Pincode`, `BluedartPincode`, and on `Shipment` as
`pickupPincode` / `destinationPincode`. Ours is a `number`.

Our query parameters use `z.coerce.number().int().positive()`, so a clean `"411001"` coerces
fine. These do not:

| Value | Result |
|---|---|
| `"411001"` | ✅ 411001 |
| `"411 001"` | ❌ 400 invalid query |
| `" 411001"` | ✅ (coerces) |
| `"IN-411001"` | ❌ 400 |
| `""` / `null` | ❌ 400 |

**Fix without touching their repo:** we strip non-digits before coercion. Recommended — it
costs us three lines and removes a whole class of 400s.

### 2.4 Dimensions: one string vs three numbers

Theirs is `dimensions: String` in `"100x50x40"` form, parsed by `calculateVolume`. They also
carry `boxes[]` with `length` / **`width`** / `height` / `weight`.

Ours takes `length`, **`breadth`**, `height`, `pieces` as separate numbers. Note the
`width` / `breadth` naming difference — easy to mis-wire silently, and it changes the
volumetric weight, which changes the price.

**Fix without touching their repo:** we accept a `dimensions=100x50x40` parameter as an
alternative to the three numbers.

Their `boxes[]` array is richer than what we accept: we take one L×B×H and a piece count, so
mixed box sizes in one consignment cannot be expressed. For volumetric-sensitive freight that
under- or over-states the chargeable weight. Worth knowing; not blocking.

### 2.5 Their `pricingSnapshot` cannot hold our breakdown

```
theirs:  baseRate · weightCost · distanceCost · volumeCost · totalCost
ours:    freight · pickup · pickupOda · delivery · deliveryOda · fuel ·
         charges[] · subTotal · gst · total  (+ tax.sac, tax.rcm, margin)
```

Nothing in their snapshot corresponds to freight, fuel, ODA, GST or the charge lines. If they
persist a quote into `pricingSnapshot` as it stands, everything except the total is lost —
and an invoice cannot be raised from a total alone.

**This one needs a change in their repo.** The smallest version: store our breakdown in the
existing `pricingTrace` field, which is looser, rather than extending `pricingSnapshot`.

### 2.6 Reverse charge is not represented

We return `tax.rcm` and a `gstNote` — under reverse charge the consignee accounts for the
GST, so we bill zero and say so. Their `Billing` has `gstAmount` and `sacCode` but no RCM
flag anywhere.

Without it, a road (GTA) shipment that is 5% RCM will either be billed 5% it should not
charge, or billed nothing with no explanation on the invoice. Both are wrong documents.

**Needs a change in their repo:** an RCM boolean on the billing record, and the note printed
on the invoice.

### 2.7 SAC codes disagree

Their `Billing.sacCode` defaults to `996791`. We return `9965` for road, rail and FTL, and
`9968` for air, NFO, courier and every Bluedart service. Both are real codes — `996791` is
the specific GTA-by-road service, `9965` the chapter heading — but two systems must not put
different codes on the same shipment. **Business decision.**

### 2.8 The 402 and 409 responses do not exist in their flow

Our quote endpoint has three outcomes their code has no branch for:

| Status | Meaning | What must happen |
|---|---|---|
| `409` | Priced, but outside the customer's contract | Show the base price, offer to raise an exception, **do not book** |
| `402` | Priced and in contract, but the customer has no funds — credit exhausted or an overdue balance | Hold the booking, show the shortfall |
| `200` | Bookable | Proceed |

A client that assumes `200 = price` and anything else = error will either crash on the
different body shape or silently drop bookings. **Needs handling in their repo.**

---

## 3. Things that line up already

Worth knowing, because they need no work:

- **`customerMasterId`** (String, on `CustomerUser` and `ContractRequest`) is exactly our
  `customer` code. Register it once via `POST /api/customers { code, name }` and contract
  pricing works. Our codes are upper-cased on registration, so match case-insensitively.
- **`declaredValue`** on `Shipment` is what Bluedart FOV needs (0.33%, min ₹200).
- **`weight`** is a required Number on `Shipment` — directly usable.
- **`ContractRequest`** (`pending` / `approved` / `rejected`, with `adminNotes`,
  `effectiveFrom`) is conceptually our contract proposal. If they ever want one queue rather
  than two, these are the two ends of the same idea.
- **`Billing.creditDays`** (30/45/60) is our `paymentTermsDays`.
- **`Plant`** with `gstNumber` matches our plants-per-customer model.

---

## 4. Two sources of truth to resolve

Both systems hold a pincode master and both hold Bluedart serviceability.

| | infracharge | this service |
|---|---|---|
| Pincode master | `Pincode` — hub, zone, serviceZone, oda, odaStatus, odaSlab, lane, SLA, lat/lon | 19,494 pincodes with a per-mode resolution: air, surface, rail, and Bluedart directional zone |
| Bluedart | `BluedartPincode` — a serviceability cache (`serviceable`, `delivery`, `serviceCenter`) synced from Blue Dart | zone (WEST/NORTH/SOUTH/EAST/NE & REMOTE) + ODA tier + EDL km, which is what actually prices |

These answer different questions — theirs is "can Blue Dart deliver here", ours is "what does
it cost" — so both can stand. But **serviceability must have one owner**, or a booking will
be accepted by one system and refused by the other. Recommended: their master owns
*serviceability*, ours owns *zone and price*, and the booking flow asks us for the price only
after their check passes.

---

## 5. What to change, by side

### Our side — removes the need for any change in their repo

1. Accept pincodes as strings, stripping non-digits (§2.3).
2. Alias their vehicle codes to ours (§2.1) — pending two answers.
3. Accept `dimensions=LxWxH` as an alternative to three numbers (§2.4).
4. Publish an explicit `transportMode` → endpoint mapping so their router cannot guess (§2.2).

### Their side — genuinely unavoidable

1. `PRICING_API_URL` and `PRICING_API_KEY` in the environment, and the `x-api-key` header on
   every call. Nothing else authenticates.
2. Somewhere to keep our breakdown — `pricingTrace` is the least invasive (§2.5).
3. An RCM flag on billing, and the note on the invoice (§2.6).
4. Handling for `402` and `409` in the booking flow (§2.8).

### Business decisions needed before any of it

1. `TRUCK_32FT` — single- or multi-axle?
2. `TATA_SUPER_ACE` and `BOLERO_PICKUP` — both the 1.5 t pickup, or distinct?
3. `TRUCK_24FT` — add a 24 ft vehicle to the rate card, or drop it?
4. `DART_PLUS`, `VELOSKY`, `VELOFREIGHT`, `VELODOC`, `DOMESTIC_PRIORITY` — out of scope, or
   missing from the franchise rate card?
5. `BUS` and `HAND_CARRY` — priced here at all? (A Raymond's contract has a bus rate.)
6. SAC: `996791` or `9965`/`9968`?
7. Rounding: we quote unrounded (Bluedart totals carry four decimals, matching their
   workbook). Where does the rupee get rounded — at quote, or at invoice?
