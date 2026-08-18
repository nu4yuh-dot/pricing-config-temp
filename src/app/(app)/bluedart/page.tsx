import { liveCardsFromSource } from '../../../data/rate-cards';
import { findPincode } from '../../../data/pincodes';
import { quoteBluedart } from '../../../pricing/bluedart';
import {
  BLUEDART_SERVICES,
  SERVICE_LABELS,
  MIN_WEIGHT,
  type BluedartService,
} from '../../../domain/bluedart';

/**
 * The Bluedart calculator.
 *
 * Its own page rather than a fourth column on the DNS calculator: the question is different.
 * There is no origin — everything is ex-Pune — and the choice is a service rather than a
 * mode, so the two cannot be compared side by side without implying they are alternatives
 * for the same shipment.
 */

interface Search {
  to?: string;
  weight?: string;
  service?: string;
  value?: string;
  length?: string;
  breadth?: string;
  height?: string;
  pieces?: string;
}

const rupees = (value: number) =>
  value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function BluedartCalculatorPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const to = Number(params.to ?? 110001);
  const weight = Number(params.weight ?? 30);
  const declaredValue = Number(params.value ?? 5000);
  const length = Number(params.length ?? 0);
  const breadth = Number(params.breadth ?? 0);
  const height = Number(params.height ?? 0);
  const pieces = Number(params.pieces ?? 1);
  const chosen = (BLUEDART_SERVICES as readonly string[]).includes(params.service ?? '')
    ? (params.service as BluedartService)
    : null;

  const [card] = await liveCardsFromSource('bluedart');
  const destination = await findPincode(to);
  const data = card?.data.bluedart ?? null;

  // Every service is priced, so the desk can see what the alternatives cost rather than
  // having to run the calculator four times.
  const results = data
    ? BLUEDART_SERVICES.map((service) => ({
        service,
        result: quoteBluedart(
          {
            service,
            actualWeight: weight,
            declaredValue,
            ...(length > 0 ? { length } : {}),
            ...(breadth > 0 ? { breadth } : {}),
            ...(height > 0 ? { height } : {}),
            pieces,
          },
          destination?.bluedart ?? null,
          data,
        ),
      }))
    : [];

  const priced = results.filter((entry) => entry.result.available);
  const cheapest =
    priced.length > 0
      ? Math.min(...priced.map((entry) => (entry.result.available ? entry.result.breakdown.total : Infinity)))
      : null;

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Bluedart calculator</h2>
        <p className="lede">
          The franchise card, ex-Pune. There is no origin to pick — the price depends on the
          destination zone, the service and the weight. All four services are priced together so
          the alternatives are visible. Quotes read approved values.
        </p>

        {!card && (
          <div className="callout bad">
            <strong>The Bluedart card is not seeded</strong>
            Run <code>npx tsx scripts/seed.ts</code> to load it.
          </div>
        )}

        <form className="inline-form" method="get">
          <div className="field">
            <label htmlFor="to">Destination pincode</label>
            <input id="to" name="to" defaultValue={to} size={8} />
          </div>
          <div className="field">
            <label htmlFor="weight">Actual kg</label>
            <input id="weight" name="weight" defaultValue={weight} size={6} />
          </div>
          <div className="field">
            <label htmlFor="value">Declared value ₹</label>
            <input id="value" name="value" defaultValue={declaredValue} size={9} />
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
          <button className="primary" type="submit">
            Quote
          </button>
        </form>

        {!destination && (
          <div className="callout bad">
            <strong>Pincode {to} is not in the pincode master</strong>
            Nothing can be priced without a zone.
          </div>
        )}
        {destination && !destination.bluedart && (
          <div className="callout bad">
            <strong>Pincode {to} has no Bluedart zone</strong>
            Run <code>npx tsx scripts/migrate-bluedart.ts</code> to merge the directional zones in.
          </div>
        )}

        {destination?.bluedart && (
          <>
            <h3>Destination</h3>
            <table className="data">
              <tbody>
                <tr>
                  <td style={{ width: 200 }}>Zone</td>
                  <td>
                    <strong>{destination.bluedart.zone}</strong>
                    <span style={{ color: 'var(--ink-faint)' }}>
                      {' '}
                      · {destination.area}, {destination.bluedart.district}, {destination.state}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>ODA status</td>
                  <td>
                    {destination.bluedart.odaStatus}
                    {destination.bluedart.edlKm > 0 && (
                      <span style={{ color: 'var(--ink-faint)' }}>
                        {' '}
                        · {destination.bluedart.edlKm} km from the nearest service centre
                      </span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )}

        <h3>All four services</h3>
        <div className="quote-grid">
          {results.map(({ service, result }) => (
            <div
              key={service}
              className={`quote-card${result.available ? '' : ' unavailable'}${
                chosen === service ? ' chosen' : ''
              }`}
            >
              <header>
                <div className="name">{service}</div>
                <div className="method">{SERVICE_LABELS[service]}</div>
                {result.available && cheapest !== null && result.breakdown.total === cheapest && (
                  <div className="cheapest">Lowest total</div>
                )}
              </header>
              {result.available ? (
                <table>
                  <tbody>
                    <tr>
                      <td>
                        Chargeable
                        <span className="hint"> min {MIN_WEIGHT[service]} kg</span>
                      </td>
                      <td>{result.breakdown.chargeableWeight} kg</td>
                    </tr>
                    <tr>
                      <td>Freight</td>
                      <td>{rupees(result.breakdown.freight)}</td>
                    </tr>
                    {result.breakdown.oda > 0 && (
                      <tr>
                        <td>ODA / EDL</td>
                        <td>{rupees(result.breakdown.oda)}</td>
                      </tr>
                    )}
                    <tr>
                      <td>
                        Fuel
                        <span className="hint"> {(result.breakdown.fuelRate * 100).toFixed(0)}%</span>
                      </td>
                      <td>{rupees(result.breakdown.fuel)}</td>
                    </tr>
                    {result.breakdown.awb > 0 && (
                      <tr>
                        <td>AWB</td>
                        <td>{rupees(result.breakdown.awb)}</td>
                      </tr>
                    )}
                    {result.breakdown.fov > 0 && (
                      <tr className="rule">
                        <td>FOV</td>
                        <td>{rupees(result.breakdown.fov)}</td>
                      </tr>
                    )}
                    <tr>
                      <td>Sub-total</td>
                      <td>{rupees(result.breakdown.subTotal)}</td>
                    </tr>
                    <tr>
                      <td>
                        GST {(result.breakdown.gstRate * 100).toFixed(0)}%
                        <span className="hint"> SAC {result.breakdown.sac}</span>
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
      </div>
    </div>
  );
}
