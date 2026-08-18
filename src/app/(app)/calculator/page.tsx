import Link from 'next/link';
import { liveCardsFromSource } from '../../../data/rate-cards';
import { findPincodePair } from '../../../data/pincodes';
import { listCustomers, findCustomer, baseCardFor, contractedCard } from '../../../data/customers';
import { checkContract, overrideCount } from '../../../customers/contract';
import { quote, type QuoteResult } from '../../../pricing/quote';
import { MODES, type Mode } from '../../../domain/types';

/**
 * The Rate Calculator, with every rate card priced side by side — which is the
 * reason three models exist. Reads live versions only, so a pending edit can never
 * appear in a number anyone might quote.
 */

interface Search {
  customer?: string;
  mode?: string;
  from?: string;
  to?: string;
  weight?: string;
  length?: string;
  breadth?: string;
  height?: string;
  pieces?: string;
  single?: string;
}

const rupees = (value: number) =>
  value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function CalculatorPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const mode = (MODES.includes(params.mode as Mode) ? params.mode : 'surface') as Mode;
  const from = Number(params.from ?? 411001);
  const to = Number(params.to ?? 110001);
  const weight = Number(params.weight ?? 200);
  const length = Number(params.length ?? 0);
  const breadth = Number(params.breadth ?? 0);
  const height = Number(params.height ?? 0);
  const pieces = Number(params.pieces ?? 1);
  const single = params.single === 'on';

  const shipment = {
    mode,
    actualWeight: weight,
    length,
    breadth,
    height,
    pieces,
    singlePackageOver100kg: single,
  };

  // DNS only: the three cards are one network priced three ways, so they compare. The
  // Bluedart card has no lane matrices at all and is quoted on its own page.
  const [cards, customers, { origin, destination }] = await Promise.all([
    liveCardsFromSource('dns'),
    listCustomers(),
    findPincodePair(from, to),
  ]);

  /**
   * With a customer selected the question changes: not "what do the three cards say" but
   * "what does this customer pay". That is one card — the one their contract is written
   * against — with their negotiated cells applied, and their billing terms, which change
   * the GST. The standard price is kept alongside so the difference is visible.
   */
  const customer = params.customer ? await findCustomer(params.customer) : null;
  const contracted = customer ? await contractedCard(customer) : null;
  const standard = customer ? await baseCardFor(customer) : null;
  const billing = customer?.commercial
    ? {
        billingType: customer.commercial.billingType,
        gstApplicable: customer.commercial.gstApplicable,
      }
    : undefined;

  // The contract quote carries the customer's cell map so its breakdown can say which
  // lanes were negotiated. The standard quote deliberately does not: it is the price
  // before negotiation, so every lane on it is the base card by definition.
  const contractQuote =
    contracted &&
    quote(
      shipment,
      { origin, destination },
      contracted,
      billing,
      customer?.liveTerms.overrides,
      customer?.liveTerms.laneRules,
    );
  const standardQuote = standard && quote(shipment, { origin, destination }, standard, billing);

  // Coverage is checked against what would actually be billed, so the zones and weight
  // come from the quote rather than from the raw inputs.
  const resolved = contractQuote?.available
    ? contractQuote.breakdown
    : standardQuote?.available
      ? standardQuote.breakdown
      : null;
  const coverage =
    customer && resolved
      ? checkContract(customer.liveTerms.scope, {
          mode,
          origin: resolved.originZone,
          destination: resolved.destinationZone,
          chargeableWeight: resolved.chargeableWeight,
        })
      : null;
  const negotiated = customer ? overrideCount(customer.liveTerms.overrides).total : 0;

  const results: { name: string; method: string; result: QuoteResult }[] = customer
    ? []
    : cards.map((card) => ({
        name: card.name,
        method: card.freightMethod,
        result: quote(shipment, { origin, destination }, card),
      }));

  const totals = results
    .map((entry) => (entry.result.available ? entry.result.breakdown.total : null))
    .filter((value): value is number => value !== null);
  const cheapest = totals.length > 0 ? Math.min(...totals) : null;
  // The zone, weight and transit panel is the same whichever card answered, so it takes
  // whichever quote is available — the customer's, or the first standard card.
  const first = results.find((entry) => entry.result.available);
  const shared = resolved ?? (first?.result.available ? first.result.breakdown : null);

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Rate Calculator</h2>
        <p className="lede">
          {customer
            ? `Priced on ${customer.name}'s contract — their card, their negotiated cells and their billing terms, with the standard price alongside for comparison.`
            : 'Enter both pincodes, the mode and the weight. All three rate cards are priced together — they use different freight formulas, so the same shipment can land at three different totals.'}{' '}
          Quotes always read approved values.
        </p>

        <form className="inline-form" method="get">
          <div className="field">
            <label htmlFor="customer">Customer</label>
            <select id="customer" name="customer" defaultValue={params.customer ?? ''}>
              <option value="">Standard rates — compare all cards</option>
              {customers.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name} ({entry.code})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="mode">Mode</label>
            <select id="mode" name="mode" defaultValue={mode}>
              {MODES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry === 'nfo' ? 'NFO / JIT' : entry.charAt(0).toUpperCase() + entry.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="from">From pincode</label>
            <input id="from" name="from" defaultValue={from} size={8} />
          </div>
          <div className="field">
            <label htmlFor="to">To pincode</label>
            <input id="to" name="to" defaultValue={to} size={8} />
          </div>
          <div className="field">
            <label htmlFor="weight">Actual kg</label>
            <input id="weight" name="weight" defaultValue={weight} size={6} />
          </div>
          <div className="field">
            <label htmlFor="length">L cm</label>
            <input id="length" name="length" defaultValue={length} size={4} />
          </div>
          <div className="field">
            <label htmlFor="breadth">B cm</label>
            <input id="breadth" name="breadth" defaultValue={breadth} size={4} />
          </div>
          <div className="field">
            <label htmlFor="height">H cm</label>
            <input id="height" name="height" defaultValue={height} size={4} />
          </div>
          <div className="field">
            <label htmlFor="pieces">Pieces</label>
            <input id="pieces" name="pieces" defaultValue={pieces} size={4} />
          </div>
          <div className="field">
            <label htmlFor="single">Single box ≥100kg</label>
            <input id="single" name="single" type="checkbox" defaultChecked={single} />
          </div>
          <button className="primary" type="submit">
            Quote
          </button>
        </form>

        {!origin && (
          <div className="callout bad">
            <strong>Origin pincode {from} is not in the pincode master</strong>
            Nothing can be priced without a zone. Check the number, or add it on the Pincodes page.
          </div>
        )}
        {!destination && (
          <div className="callout bad">
            <strong>Destination pincode {to} is not in the pincode master</strong>
            Nothing can be priced without a zone.
          </div>
        )}

        {shared && (
          <>
            <h3>Shipment</h3>
            <table className="data">
              <tbody>
                <tr>
                  <td>Route</td>
                  <td>
                    <strong>{shared.originZone}</strong> → <strong>{shared.destinationZone}</strong>
                    {origin && destination && (
                      <span style={{ color: 'var(--ink-faint)' }}>
                        {' '}
                        · {origin.area} → {destination.area}
                      </span>
                    )}
                  </td>
                </tr>
                <tr>
                  <td>Chargeable weight</td>
                  <td className="num">
                    {shared.chargeableWeight} kg
                    {shared.volumetricWeight > 0 && (
                      <span style={{ color: 'var(--ink-faint)' }}>
                        {' '}
                        (volumetric {shared.volumetricWeight} kg)
                      </span>
                    )}
                  </td>
                </tr>
                <tr>
                  <td>Transit</td>
                  <td className="num">
                    {mode === 'nfo' ? '10–14 hrs' : shared.transitDays !== null ? `${shared.transitDays} days` : '—'}
                  </td>
                </tr>
                <tr>
                  <td>ODA distance</td>
                  <td className="num">
                    origin {shared.originEdlKm} km · destination {shared.destinationEdlKm} km
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )}

        {customer && contractQuote && (
          <>
            <h3>
              {customer.name}{' '}
              <span style={{ fontWeight: 400, color: 'var(--ink-faint)', fontSize: 12 }}>
                {customer.code} · {negotiated} negotiated{' '}
                {negotiated === 1 ? 'cell' : 'cells'} ·{' '}
                <Link href={`/customers/${encodeURIComponent(customer.code)}`}>open the contract →</Link>
              </span>
            </h3>

            {coverage && !coverage.inContract && (
              <div className="callout bad">
                <strong>This shipment is outside their contract</strong>
                <ul>
                  {coverage.messages.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
                Booking it needs an approved exception. The price below is what the contract
                would charge if it were covered.
              </div>
            )}

            <div className="quote-grid">
              {([
                ['Contracted', contractQuote],
                ['Standard', standardQuote],
              ] as const).map(([label, result]) => (
                <div
                  key={label}
                  className={`quote-card${result && result.available ? '' : ' unavailable'}`}
                >
                  <header>
                    <div className="name">{label}</div>
                    <div className="method">
                      {label === 'Contracted' ? `${contracted?.name}` : 'before negotiation'}
                    </div>
                  </header>
                  {result && result.available ? (
                    <table>
                      <tbody>
                        <tr>
                          <td>
                            Freight
                            <span className="hint"> {result.breakdown.laneProvenance.trace}</span>
                          </td>
                          <td>{rupees(result.breakdown.freight)}</td>
                        </tr>
                        <tr>
                          <td>Cartage</td>
                          <td>
                            {rupees(
                              result.breakdown.pickup +
                                result.breakdown.pickupOda +
                                result.breakdown.delivery +
                                result.breakdown.deliveryOda,
                            )}
                          </td>
                        </tr>
                        <tr>
                          <td>
                            Fuel
                            <span className="hint"> on {result.breakdown.fuelBaseDescription}</span>
                          </td>
                          <td>{rupees(result.breakdown.fuel)}</td>
                        </tr>
                        {result.breakdown.charges.map((charge, index) => (
                          <tr
                            key={charge.id}
                            className={
                              index === result.breakdown.charges.length - 1 ? 'rule' : undefined
                            }
                          >
                            <td>{charge.name}</td>
                            <td>{rupees(charge.amount + charge.fuel)}</td>
                          </tr>
                        ))}
                        <tr>
                          <td>Sub-total</td>
                          <td>{rupees(result.breakdown.subTotal)}</td>
                        </tr>
                        <tr>
                          <td>
                            GST {(result.breakdown.tax.gstRate * 100).toFixed(0)}%
                            <span className="hint"> SAC {result.breakdown.tax.sac}</span>
                          </td>
                          <td>{rupees(result.breakdown.gst)}</td>
                        </tr>
                        <tr className="total">
                          <td>Total</td>
                          <td>₹{rupees(result.breakdown.total)}</td>
                        </tr>
                      </tbody>
                    </table>
                  ) : (
                    <table>
                      <tbody>
                        <tr>
                          <td colSpan={2}>
                            {result && !result.available ? result.message : 'Not priced.'}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  )}
                  {result && result.available && result.breakdown.gstNote && (
                    <p className="quote-note">{result.breakdown.gstNote}</p>
                  )}
                </div>
              ))}
            </div>

            {contractQuote.available && standardQuote?.available && (
              <p style={{ color: 'var(--ink-soft)' }}>
                {contractQuote.breakdown.total === standardQuote.breakdown.total ? (
                  <>
                    Nothing is negotiated on this lane, so {customer.name} pays the standard price.
                  </>
                ) : (
                  <>
                    {customer.name} pays{' '}
                    <strong>
                      ₹{rupees(Math.abs(standardQuote.breakdown.total - contractQuote.breakdown.total))}
                    </strong>{' '}
                    {contractQuote.breakdown.total < standardQuote.breakdown.total ? 'less' : 'more'}{' '}
                    than standard on this shipment (
                    {(
                      ((contractQuote.breakdown.total - standardQuote.breakdown.total) /
                        standardQuote.breakdown.total) *
                      100
                    ).toFixed(1)}
                    %).
                  </>
                )}
              </p>
            )}
          </>
        )}

        {!customer && <h3>All three cards</h3>}
        <div className="quote-grid">
          {results.map(({ name, method, result }) => (
            <div
              key={name}
              className={`quote-card${result.available ? '' : ' unavailable'}`}
            >
              <header>
                <div className="name">{name}</div>
                <div className="method">{method}</div>
                {result.available && cheapest !== null && result.breakdown.total === cheapest && (
                  <div className="cheapest">Lowest total</div>
                )}
              </header>
              {result.available ? (
                <table>
                  <tbody>
                    <tr>
                      <td>Freight</td>
                      <td>{rupees(result.breakdown.freight)}</td>
                    </tr>
                    <tr>
                      <td>Pickup</td>
                      <td>{rupees(result.breakdown.pickup)}</td>
                    </tr>
                    {result.breakdown.pickupOda > 0 && (
                      <tr>
                        <td>Pickup ODA</td>
                        <td>{rupees(result.breakdown.pickupOda)}</td>
                      </tr>
                    )}
                    <tr>
                      <td>Delivery</td>
                      <td>{rupees(result.breakdown.delivery)}</td>
                    </tr>
                    {result.breakdown.deliveryOda > 0 && (
                      <tr>
                        <td>Delivery ODA</td>
                        <td>{rupees(result.breakdown.deliveryOda)}</td>
                      </tr>
                    )}
                    <tr>
                      <td>
                        Fuel
                        <span className="hint"> on {result.breakdown.fuelBaseDescription}</span>
                      </td>
                      <td>{rupees(result.breakdown.fuel)}</td>
                    </tr>
                    {result.breakdown.charges.map((charge, index) => (
                      <tr
                        key={charge.id}
                        className={index === result.breakdown.charges.length - 1 ? 'rule' : undefined}
                      >
                        <td>
                          {charge.name}
                          {!charge.gstApplies && <span className="hint"> outside GST</span>}
                        </td>
                        <td>{rupees(charge.amount + charge.fuel)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>Sub-total</td>
                      <td>{rupees(result.breakdown.subTotal)}</td>
                    </tr>
                    <tr>
                      <td>
                        GST {(result.breakdown.tax.gstRate * 100).toFixed(0)}%
                        <span className="hint"> SAC {result.breakdown.tax.sac}</span>
                      </td>
                      <td>{rupees(result.breakdown.gst)}</td>
                    </tr>
                    <tr className="total">
                      <td>Total</td>
                      <td>₹{rupees(result.breakdown.total)}</td>
                    </tr>
                  </tbody>
                </table>
              ) : null}
              {result.available && result.breakdown.gstNote && (
                <p className="quote-note">{result.breakdown.gstNote}</p>
              )}
              {result.available && result.breakdown.margin && (
                <p
                  className={`quote-note${
                    result.breakdown.margin.loss || result.breakdown.margin.thin ? ' bad' : ''
                  }`}
                >
                  {result.breakdown.margin.carrier} costs ₹{rupees(result.breakdown.margin.buy)} on
                  this lane — margin ₹{rupees(result.breakdown.margin.profit)}
                  {result.breakdown.margin.ratio !== null &&
                    ` (${(result.breakdown.margin.ratio * 100).toFixed(1)}%)`}
                  {result.breakdown.margin.loss
                    ? ' · selling below cost'
                    : result.breakdown.margin.thin
                      ? ' · below the margin floor'
                      : ''}
                  .
                </p>
              )}
              {!result.available && (
                <table>
                  <tbody>
                    <tr>
                      <td colSpan={2}>{result.message}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>

        {results.some((entry) => entry.result.available && entry.result.warnings.length > 0) && (
          <div className="callout">
            <strong>Worth checking</strong>
            <ul>
              {results
                .flatMap((entry) => (entry.result.available ? entry.result.warnings : []))
                .filter((message, index, all) => all.indexOf(message) === index)
                .map((message) => (
                  <li key={message}>{message}</li>
                ))}
            </ul>
          </div>
        )}

        {cheapest !== null && totals.length > 1 && Math.max(...totals) !== cheapest && (
          <p style={{ color: 'var(--ink-soft)' }}>
            Spread between the cheapest and dearest card on this shipment:{' '}
            <strong>₹{rupees(Math.max(...totals) - cheapest)}</strong> (
            {(((Math.max(...totals) - cheapest) / cheapest) * 100).toFixed(1)}%).
          </p>
        )}
      </div>
    </div>
  );
}
