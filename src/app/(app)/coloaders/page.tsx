import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../auth/session';
import { listCards, liveVersion } from '../../../data/rate-cards';
import { listCustomers } from '../../../data/customers';
import { effectiveCard } from '../../../customers/contract';
import { coloadersFrom, laneMargins } from '../../../domain/coloaders';
import { AIR_ZONES, SURFACE_ZONES } from '../../../domain/zones';
import type { StoredMode } from '../../../domain/types';

/**
 * Co-loaders — the buy side, with the margin every customer earns on a lane beside it.
 *
 * The engine has held buy tariffs since margin was built; what it never had was a place
 * to look at one. A buy rate on its own says nothing and a sell rate on its own says
 * nothing, so this puts them in the same table, freight against freight.
 */
export default async function ColoadersPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; origin?: string; destination?: string; weight?: string }>;
}) {
  const user = await currentUser();
  if (!user) notFound();

  const query = await searchParams;
  const [cards, customers] = await Promise.all([listCards(), listCustomers()]);
  const versions = await Promise.all(cards.map((card) => liveVersion(card.key)));

  const withData = cards.map((card, index) => ({
    key: card.key,
    name: card.name,
    data: versions[index]!.data,
    freightMethod: card.freightMethod,
  }));
  const coloaders = coloadersFrom(withData);

  const mode = (['air', 'surface', 'rail'].includes(query.mode ?? '')
    ? query.mode
    : 'air') as StoredMode;
  const weight = Number(query.weight) > 0 ? Number(query.weight) : 100;
  const zones: readonly string[] = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;
  const origin = zones.includes(query.origin ?? '') ? (query.origin as string) : (zones[0] as string);
  const destination = zones.includes(query.destination ?? '')
    ? (query.destination as string)
    : ((zones[1] ?? zones[0]) as string);

  // One co-loader at a time: the margin table only means anything against a single buy
  // tariff, and a combined view would be several different bargains stacked in a column.
  const chosen = coloaders[0];
  const chosenCard = chosen ? withData.find((card) => card.key === chosen.cardKey) : undefined;

  const rows =
    chosen && chosenCard?.data.cost
      ? laneMargins({
          cardKey: chosen.cardKey,
          cost: chosenCard.data.cost,
          mode,
          origin,
          destination,
          chargeableWeight: weight,
          minWeight:
            mode === 'air'
              ? chosenCard.data.charges.minWeightAir
              : chosenCard.data.charges.minWeightSurface,
          sellMethod: chosenCard.freightMethod,
          customers: customers.map((customer) => {
            const contracted = effectiveCard(
              { ...chosenCard, data: chosenCard.data } as never,
              customer.liveTerms,
            ).data.grids[mode];
            return {
              code: customer.code,
              name: customer.name,
              baseCardKey: customer.baseCardKey,
              rates: {
                minCharge: contracted.minCharge[origin]?.[destination] ?? null,
                tier1: contracted.tier1[origin]?.[destination] ?? null,
                tier2: contracted.tier2[origin]?.[destination] ?? null,
                tier3: contracted.tier3[origin]?.[destination] ?? null,
              },
            };
          }),
        })
      : [];

  const compared = rows.filter((row) => row.margin !== null);

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Co-loaders</h2>
        <p className="lede">
          A co-loader&rsquo;s buy rate is the same lane, mode and weight shape as a customer&rsquo;s
          sell rate, and the same freight function prices both. Nothing here is a second pricing
          model — it is the cost tariff a card already carries, named, with the margin every
          customer on that card earns against it.
        </p>

        {coloaders.length === 0 ? (
          <div className="panel">
            <div className="empty">
              No card carries a buy tariff yet. A cost grid is added to a card and margin follows
              from it — there is nothing separate to set up.
            </div>
          </div>
        ) : (
          <>
            <table className="data" style={{ marginBottom: 16 }}>
              <thead>
                <tr>
                  <th>Co-loader</th>
                  <th>Buys against</th>
                  <th>Modes priced</th>
                  <th style={{ textAlign: 'right' }}>Lanes</th>
                </tr>
              </thead>
              <tbody>
                {coloaders.map((coloader) => (
                  <tr key={coloader.cardKey}>
                    <td>
                      <strong>{coloader.carrier}</strong>
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      <Link href={`/console/${coloader.cardKey}/rates`}>{coloader.cardName}</Link>
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>{coloader.modes.join(', ')}</td>
                    <td className="num">{coloader.lanes}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>
              {chosen?.carrier} — margin on {origin} → {destination} by {mode}, at {weight} kg
            </h3>
            <form method="get" className="inline-form" style={{ marginBottom: 12 }}>
              <div className="field">
                <label htmlFor="cl-mode">Mode</label>
                <select id="cl-mode" name="mode" defaultValue={mode}>
                  <option value="air">Air</option>
                  <option value="surface">Surface</option>
                  <option value="rail">Rail</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="cl-origin">From</label>
                <select id="cl-origin" name="origin" defaultValue={origin}>
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cl-dest">To</label>
                <select id="cl-dest" name="destination" defaultValue={destination}>
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ maxWidth: 110 }}>
                <label htmlFor="cl-weight">Weight (kg)</label>
                <input id="cl-weight" name="weight" defaultValue={weight} inputMode="decimal" />
              </div>
              <button className="btn" type="submit">
                Show margin
              </button>
            </form>

            {compared.length === 0 ? (
              <p className="empty">
                No customer on {chosen?.cardName} carries that lane, so there is nothing to compare.
              </p>
            ) : (
              <div className="scroll-x">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th style={{ textAlign: 'right' }}>Sell freight</th>
                      <th style={{ textAlign: 'right' }}>Buy freight</th>
                      <th style={{ textAlign: 'right' }}>Margin</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {compared.map((row) => (
                      <tr key={row.customerCode}>
                        <td>
                          <Link href={`/customers/${encodeURIComponent(row.customerCode)}`}>
                            {row.customerName}
                          </Link>
                        </td>
                        <td className="num">₹{row.sell.toFixed(2)}</td>
                        <td className="num">₹{row.margin?.buy.toFixed(2)}</td>
                        <td
                          className="num"
                          style={{
                            color: row.margin?.loss
                              ? 'var(--rejected)'
                              : row.margin?.thin
                                ? 'var(--pending)'
                                : 'var(--live)',
                          }}
                        >
                          {(row.margin?.profit ?? 0) >= 0 ? '+' : ''}
                          {row.margin?.profit.toFixed(2)}
                        </td>
                        <td>
                          {row.margin?.loss ? (
                            <span className="chip rejected">selling under cost</span>
                          ) : row.margin?.thin ? (
                            <span className="chip pending">thin</span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
              Both sides are freight only, before fuel, cartage and tax. Comparing a landed sell
              price against a bare buy rate would flatter every lane on the list.
            </p>
          </>
        )}

        <div className="panel" style={{ marginTop: '1.4rem' }}>
          <h3>Lane-to-vendor priority is not here</h3>
          <p>
            The mockup&rsquo;s second half assigns a first and second choice co-loader per lane, to
            decide which one a booking goes to. That is booking-time routing, and this system does
            none — there is no booking screen for it to act on, which is also why a one-off charge
            cannot yet be attached at a booking. Built now, it would be a table of preferences
            nothing reads, and a preference nothing reads is worse than an absent feature: it
            looks like a decision that is in force.
          </p>
        </div>
      </div>
    </div>
  );
}
