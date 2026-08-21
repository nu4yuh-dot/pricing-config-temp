import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '../../../../auth/session';
import { can } from '../../../../auth/roles';
import { quoteById, fingerprint } from '../../../../data/quotes';
import { liveCard } from '../../../../data/rate-cards';
import { findCustomer } from '../../../../data/customers';

/**
 * One quote, in full, and whether it would still be priced the same way.
 *
 * The list on `/audit` answers "what have we been quoting". This answers the question that
 * actually gets asked, weeks later, usually by a customer: **why is the price different
 * now?** A stored quote alone cannot answer that — it says what happened, not what changed.
 * So the two things that could have moved underneath it are compared against what is live
 * today: the card version, and the customer's contract.
 *
 * Everything here is read from the record rather than recomputed. Repricing the shipment to
 * show a comparison would be a different number reached a different way, and the value of a
 * stored quote is that it is exactly what was said at the time.
 */

const money = (value: unknown) =>
  typeof value === 'number' ? `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—';

/** Breakdown keys that are money, so they can be shown as money and not as bare numbers. */
const MONEY_KEYS = new Set([
  'baseFreight', 'minFreight', 'freightSubtotal', 'adjustedFreight', 'pickupCharge',
  'deliveryCharge', 'odaOriginCharge', 'odaDestCharge', 'fuelSurchargeAmt', 'awbCharge',
  'handlingCharge', 'codFee', 'insuranceCharge', 'discountAmt', 'subtotal', 'gstAmt', 'total',
]);

/** Keys the core owns and this service never fills in. Shown once, not fifteen times. */
const CORE_OWNED = new Set([
  'vehicle', 'vehicleName', 'vehicleMaxWt', 'vehicleMaxL', 'vehicleMaxW', 'vehicleMaxH',
  'vehicleCategory', 'carrierId', 'carrierName', 'carrierSelectionReason',
]);

const LABELS: Record<string, string> = {
  actualWeight: 'Actual weight',
  volumetricWeight: 'Volumetric weight',
  chargeableWeight: 'Chargeable weight',
  chargeableWeightSupplied: 'Chargeable weight, as supplied',
  volDivisor: 'Volumetric divisor',
  rateSource: 'How the rate resolved',
  ratePerKg: 'Tariff rate per kg',
  minFreight: 'Minimum freight',
  baseFreight: 'Freight',
  serviceMult: 'Service multiplier',
  serviceMultName: 'Priced by',
  freightSubtotal: 'Freight before adjustment',
  adjustedFreight: 'Freight after adjustment',
  discountPct: 'Discount',
  discountAmt: 'Discount amount',
  pickupCharge: 'Pickup',
  deliveryCharge: 'Delivery',
  odaOriginCharge: 'ODA at origin',
  odaOriginStatus: 'Origin ODA status',
  odaDestCharge: 'ODA at destination',
  odaDestStatus: 'Destination ODA status',
  fuelSurchargePct: 'Fuel rate',
  fuelSurchargeAmt: 'Fuel',
  awbCharge: 'Docket / AWB',
  handlingCharge: 'Handling',
  codFee: 'COD fee',
  insuranceCharge: 'Insurance',
  subtotal: 'Sub-total',
  gstProfile: 'SAC',
  gstPct: 'GST rate',
  gstAmt: 'GST',
  total: 'Total',
  originCity: 'Origin city',
  destCity: 'Destination city',
  chargeConfigName: 'Charge configuration',
  pdConfigName: 'Pickup/delivery configuration',
  odaConfigName: 'ODA configuration',
};

export default async function QuoteAuditPage({
  params,
}: {
  params: Promise<{ quoteId: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!can(user.role, 'view-audit-log')) redirect('/console/model-1/rates');

  const { quoteId } = await params;
  const quote = await quoteById(decodeURIComponent(quoteId));
  if (!quote) notFound();

  const priced = quote.pricedAgainst;

  // What could have moved since. Both are read as they are now, and compared — not repriced.
  const card = await liveCard(priced.cardKey);
  const customer = priced.customerCode ? await findCustomer(priced.customerCode) : null;
  const contractNow = customer ? fingerprint(customer.liveTerms) : null;

  const cardMoved =
    priced.cardVersion !== undefined && card?.version !== undefined && card.version !== priced.cardVersion;
  const contractMoved =
    priced.contractFingerprint !== undefined && contractNow !== null && contractNow !== priced.contractFingerprint;
  const expired = quote.validUntil ? quote.validUntil < new Date() : false;

  const when = (date: Date) =>
    date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="page">
      <div className="page-inner">
        <p style={{ margin: '0 0 4px' }}>
          <Link href="/audit">← Rate audit</Link>
        </p>
        <h2 style={{ fontFamily: 'var(--font-mono)' }}>{quote.quoteId}</h2>
        <p className="lede">
          Quoted {when(quote.createdAt)}
          {quote.caller ? ` · asked for by ${quote.caller}` : ''} ·{' '}
          {expired ? (
            <>expired {when(quote.validUntil)}</>
          ) : (
            <>valid until {when(quote.validUntil)}</>
          )}
        </p>

        {(cardMoved || contractMoved) && (
          <div className="callout warn">
            <strong>This would not be priced the same way today</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {cardMoved && (
                <li>
                  It was priced against <strong>version {priced.cardVersion}</strong> of{' '}
                  {priced.cardName}. The live version is now{' '}
                  <strong>{card?.version}</strong>.{' '}
                  <Link href={`/history?card=${encodeURIComponent(priced.cardKey)}`}>
                    What changed
                  </Link>
                </li>
              )}
              {contractMoved && (
                <li>
                  The customer&rsquo;s contract has changed since — it fingerprinted{' '}
                  <code>{priced.contractFingerprint}</code> then and{' '}
                  <code>{contractNow}</code> now.
                </li>
              )}
            </ul>
            The figures below are what was quoted at the time. They are not restated.
          </div>
        )}

        {!cardMoved && !contractMoved && (
          <div className="callout">
            <strong>Still current</strong>
            The card version and the contract that priced this are the ones in force now, so the
            same request would resolve the same way.
          </div>
        )}

        <h3>What was asked for</h3>
        <div className="gridscroll">
          <table className="data">
            <tbody>
              <tr>
                <td>Lane</td>
                <td>
                  {quote.request.originPincode} → {quote.request.destinationPincode}
                </td>
              </tr>
              <tr>
                <td>Customer</td>
                <td>
                  {quote.request.customerCode ? (
                    <Link href={`/customers/${encodeURIComponent(quote.request.customerCode)}`}>
                      {quote.request.customerCode}
                    </Link>
                  ) : (
                    <span className="muted">none — the standard card rate</span>
                  )}
                </td>
              </tr>
              <tr>
                <td>Weight</td>
                <td>
                  {quote.request.actualWeight} kg actual
                  {quote.request.chargeableWeightSupplied !== undefined && (
                    <div className="sub">
                      {quote.request.chargeableWeightSupplied} kg chargeable, supplied by the caller
                    </div>
                  )}
                </td>
              </tr>
              {quote.request.dimensionsCm && (
                <tr>
                  <td>Dimensions</td>
                  <td>
                    {quote.request.dimensionsCm.length ?? '—'} ×{' '}
                    {quote.request.dimensionsCm.breadth ?? '—'} ×{' '}
                    {quote.request.dimensionsCm.height ?? '—'} cm
                  </td>
                </tr>
              )}
              {quote.request.transportMode && (
                <tr>
                  <td>Mode asked for</td>
                  <td>{quote.request.transportMode}</td>
                </tr>
              )}
              {quote.request.declaredValue !== undefined && (
                <tr>
                  <td>Declared value</td>
                  <td>{money(quote.request.declaredValue)}</td>
                </tr>
              )}
              {quote.request.codValue !== undefined && (
                <tr>
                  <td>COD</td>
                  <td>{money(quote.request.codValue)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <h3>What priced it</h3>
        <div className="gridscroll">
          <table className="data">
            <tbody>
              <tr>
                <td>Card</td>
                <td>
                  <Link href={`/console/${encodeURIComponent(priced.cardKey)}/rates`}>
                    {priced.cardName}
                  </Link>
                  <div className="sub">{priced.cardKey}</div>
                </td>
              </tr>
              <tr>
                <td>Version</td>
                <td>
                  {priced.cardVersion ?? <span className="muted">unversioned</span>}
                  {cardMoved && <div className="sub">live is now {card?.version}</div>}
                </td>
              </tr>
              <tr>
                <td>Contract</td>
                <td>
                  {priced.contractFingerprint ? (
                    <>
                      <code>{priced.contractFingerprint}</code>
                      <div className="sub">
                        {priced.contractOverrides ?? 0} negotiated cell
                        {priced.contractOverrides === 1 ? '' : 's'} in force
                      </div>
                    </>
                  ) : (
                    <span className="muted">no contract applied — base rates</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3>What was quoted ({quote.tiers.length})</h3>
        {quote.tiers.length === 0 ? (
          <p className="empty">
            No tier could be priced. The lane was answered as unserviceable rather than at zero.
          </p>
        ) : (
          quote.tiers.map((tier) => {
            const breakdown = tier.breakdown as Record<string, unknown>;
            const shown = Object.entries(breakdown).filter(
              ([key, value]) =>
                !CORE_OWNED.has(key) && value !== '' && value !== undefined && value !== null,
            );
            return (
              <div className="panel" key={`${tier.service}-${tier.mode}`} style={{ marginBottom: 14 }}>
                <header>
                  <h4 style={{ margin: 0 }}>
                    {tier.service} · {tier.mode}
                  </h4>
                  <span className="hint">
                    {money(tier.total)} · {tier.chargeableWeight} kg chargeable
                  </span>
                </header>
                <div className="body">
                  {typeof breakdown.rateSource === 'string' && (
                    <p className="sub" style={{ marginTop: 0 }}>
                      <strong>How the rate resolved:</strong> {breakdown.rateSource}
                    </p>
                  )}
                  <div className="gridscroll">
                    <table className="data">
                      <tbody>
                        {shown.map(([key, value]) => (
                          <tr key={key}>
                            <td>{LABELS[key] ?? key}</td>
                            <td className="num">
                              {MONEY_KEYS.has(key)
                                ? money(value)
                                : typeof value === 'object'
                                  ? JSON.stringify(value)
                                  : String(value)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="sub" style={{ marginBottom: 0 }}>
                    Vehicle and carrier are the core&rsquo;s to choose and are not recorded here.
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
