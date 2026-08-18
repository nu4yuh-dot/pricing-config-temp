import { AIR_ZONES, SURFACE_ZONES, SURFACE_ZONE_NAMES, AIR_ZONE_NAMES } from '../../../domain/zones';

/**
 * What the terms mean.
 *
 * Every one of these words appears on a screen where somebody has to make a pricing
 * decision. Each entry says what it is, and — more usefully — what happens if you
 * get it wrong.
 */

interface Entry {
  term: string;
  short: string;
  detail: string;
  consequence?: string;
  example?: string;
}

const CORE: Entry[] = [
  {
    term: 'Lane',
    short: 'One origin zone to one destination zone, for one mode.',
    detail:
      'A lane is the unit everything is priced against. "Surface PNQ→NCR" is a lane: road freight from the Pune cluster to the Delhi-NCR cluster. Air PNQ→NCR is a different lane, priced separately.',
    consequence:
      'Lanes are directional. PNQ→NCR and NCR→PNQ are two lanes and can carry different rates, because a lorry going one way may be easier to fill than coming back.',
    example: 'Surface · PNQ → NCR',
  },
  {
    term: 'Zone (cluster / hub)',
    short: 'A group of pincodes priced as one place.',
    detail:
      `Rather than pricing 19,494 pincodes individually, pincodes are grouped into zones. Surface and rail use ${SURFACE_ZONES.length} industrial clusters; air uses ${AIR_ZONES.length} airport hubs. Every pincode is tagged to a zone for each mode.`,
    consequence:
      'Two addresses in the same zone get the same lane rate, even if one is 80 km further out. That is what the ODA surcharge exists to correct.',
    example: 'PNQ = Pune City & Pune rural · NCR = Delhi, Gurugram, Manesar, Faridabad, Noida',
  },
  {
    term: 'Weight slab (tier)',
    short: 'A weight range with its own per-kg rate.',
    detail:
      'Each lane has a fixed minimum charge plus three per-kg tiers: from the minimum weight to 100 kg, 100–300 kg, and 300 kg upward. Rates step down as weight rises, because heavier shipments use the vehicle more efficiently.',
    consequence:
      'Which tier applies depends on the total chargeable weight, not on how the weight is split across boxes.',
    example: 'Surface: minimum ≤50 kg · 50–100 kg · 100–300 kg · 300 kg+',
  },
  {
    term: 'Minimum charge',
    short: 'The floor for a lane, covering everything up to the minimum weight.',
    detail:
      'A 2 kg parcel and a 50 kg consignment on the same surface lane both pay the minimum charge, because the cost of collecting and moving a small shipment barely changes below that point.',
    consequence:
      'Setting the minimum too low loses money on small shipments; too high and you price yourself out of parcel work.',
    example: 'Surface PNQ→NCR minimum ₹530 covers any shipment up to 50 kg',
  },
  {
    term: 'Chargeable weight',
    short: 'The weight you actually bill: the greater of actual and volumetric.',
    detail:
      'A pallet of cushions weighs little but fills a lorry. Volumetric weight converts the space used into a weight (L×B×H in cm ÷ 5000 for air, ÷ 4500 for surface and rail, per piece). You bill whichever is higher, and never below the mode minimum.',
    consequence:
      'Ignoring volumetric weight means carrying bulky freight at a loss. Rail adds a rule of its own: a single package of 100 kg or more is charged at twice its weight.',
    example: '2 boxes of 100×100×100 cm on air = 400 kg chargeable, whatever the scales say',
  },
];

const CHARGES: Entry[] = [
  {
    term: 'Serviceable / not serviceable',
    short: 'Whether a lane can be quoted at all.',
    detail:
      'Marking a lane "not served" is not the same as pricing it high. It removes the lane entirely — the calculator declines to quote, and the booking site cannot book it.',
    consequence:
      'Close a lane and every quote for it stops working immediately. Open one and it becomes bookable at whatever rates you set, so set the rates before opening it.',
    example: 'Air PNQ→BOM is not served: the distance is too short to fly, so it moves by road',
  },
  {
    term: 'ODA / EDL',
    short: 'Out-of-Delivery-Area surcharge, by distance from the hub.',
    detail:
      'A pincode inside its service town costs nothing extra. One 80 km beyond it needs a dedicated trip. The surcharge is looked up on distance band × weight band, and applies at both ends — the origin drives a pickup ODA, the destination a delivery ODA.',
    consequence:
      'Forgetting ODA on a rural delivery is where margin quietly disappears. Beyond the last distance band it becomes a per-km charge instead.',
  },
  {
    term: 'Pickup & delivery (cartage)',
    short: 'First and last mile, charged per zone.',
    detail:
      'The cost of collecting from the sender and delivering to the receiver, set per zone from actual billed cartage. Pickup uses the origin zone; delivery uses the destination zone.',
    consequence:
      'Both are zero when origin and destination are in the same zone, because it is a local delivery rather than a line-haul.',
  },
  {
    term: 'Fuel surcharge',
    short: 'A percentage added on top, tracking fuel prices.',
    detail:
      'Applied to freight plus pickup, delivery and both ODA legs — not to freight alone. It is separate from the rates so a diesel movement can be passed through without renegotiating every lane.',
    consequence:
      'Rail carries no fuel surcharge. Changing the fuel percentage reprices every lane on the card at once.',
  },
  {
    term: 'Docket / AWB',
    short: 'A flat per-shipment documentation charge.',
    detail: 'One fixed amount per consignment, regardless of weight or distance.',
    consequence: 'Sits outside the fuel base — fuel is not charged on the docket fee.',
  },
];

const MODES: Entry[] = [
  {
    term: 'PTL (partload)',
    short: 'Your shipment shares the vehicle.',
    detail:
      'Part-truck-load: you pay for the space you use and the vehicle carries other consignments too. Everything in these rate cards is PTL, up to 1000 kg.',
    consequence: 'Above 1000 kg it stops being PTL and is quoted as FTL instead.',
  },
  {
    term: 'FTL (full truckload)',
    short: 'The whole vehicle is yours.',
    detail:
      'Priced per vehicle and trip rather than per kg, so it does not fit the slab model. Quoted separately.',
    consequence: 'Not yet configured in this system.',
  },
  {
    term: 'NFO / JIT',
    short: 'Next Flight Out — the urgent air product.',
    detail:
      'Goes on the first available flight, 10–14 hours rather than a day count. Priced as a multiple of the standard air card.',
    consequence:
      'Because it is derived from Air, editing an air rate moves NFO with it. There is nothing separate to maintain.',
  },
  {
    term: 'TAT / ETA',
    short: 'How long it takes, in working days.',
    detail:
      'Transit time per lane. Indicative rather than guaranteed, and excludes holidays and force majeure.',
  },
];

const CONTRACT: Entry[] = [
  {
    term: 'Base rate card',
    short: 'The standard prices everyone gets.',
    detail:
      'The default. A customer with no negotiated terms is priced straight off it, and automatically follows any change you make to it.',
  },
  {
    term: 'Negotiated cell (override)',
    short: 'One agreed value that differs from standard, for one customer.',
    detail:
      'Only the differences are stored. A customer who agreed three lanes holds three values, not a copy of the whole card.',
    consequence:
      'Everything they have not negotiated keeps tracking the base card — including future changes. That is the point: you update standard pricing once and every customer follows except where you agreed otherwise.',
  },
  {
    term: 'Contract coverage (scope)',
    short: 'Which modes, lanes and weights a contract actually includes.',
    detail:
      'A contract need not cover the whole network. Coverage says what is in it; anything outside is not bookable at contract prices.',
    consequence:
      'Outside coverage the booking site is shown standard prices instead, clearly labelled, and booking needs an approved exception.',
  },
  {
    term: 'Draft / pending / approved',
    short: 'Where a change is in the approval process.',
    detail:
      'Edits land in a draft, which prices nothing. Submitting freezes it and sends it for review. Approval promotes it to live and archives the previous version.',
    consequence:
      'Quotes always read approved values, so an unfinished edit can never reach a customer.',
  },
];

function Section({ title, entries }: { title: string; entries: Entry[] }) {
  return (
    <>
      <h3>{title}</h3>
      {entries.map((entry) => (
        <div className="panel" key={entry.term}>
          <header>
            <h3>{entry.term}</h3>
            <span className="hint">{entry.short}</span>
          </header>
          <div className="body">
            <p style={{ margin: '0 0 10px' }}>{entry.detail}</p>
            {entry.consequence && (
              <p
                style={{
                  margin: '0 0 10px',
                  paddingLeft: 11,
                  borderLeft: '3px solid var(--pending)',
                  color: 'var(--ink-soft)',
                }}
              >
                <strong>Why it matters: </strong>
                {entry.consequence}
              </p>
            )}
            {entry.example && (
              <p
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  color: 'var(--ink-faint)',
                }}
              >
                {entry.example}
              </p>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

export default function GlossaryPage() {
  return (
    <div className="page">
      <div className="page-inner">
        <h2>What the terms mean</h2>
        <p className="lede">
          Every word here appears on a screen where somebody has to make a pricing decision. Each
          entry says what it is and what happens if you get it wrong.
        </p>

        <Section title="The building blocks" entries={CORE} />
        <Section title="Charges and surcharges" entries={CHARGES} />
        <Section title="Modes and products" entries={MODES} />
        <Section title="Customers and approval" entries={CONTRACT} />

        <h3>Zone codes</h3>
        <div className="scroll-x">
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Surface &amp; rail cluster</th>
                <th>Air hub</th>
              </tr>
            </thead>
            <tbody>
              {SURFACE_ZONES.map((zone) => (
                <tr key={zone}>
                  <td>
                    <strong>{zone}</strong>
                  </td>
                  <td>{SURFACE_ZONE_NAMES[zone]}</td>
                  <td style={{ color: 'var(--ink-faint)' }}>
                    {AIR_ZONES.includes(zone as never)
                      ? AIR_ZONE_NAMES[zone as (typeof AIR_ZONES)[number]]
                      : 'no air hub'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
          {SURFACE_ZONES.length} surface and rail clusters · {AIR_ZONES.length} air hubs. A zone
          with no air hub is still reachable by air through its nearest hub, with an air ODA for the
          airport-to-town leg.
        </p>
      </div>
    </div>
  );
}
