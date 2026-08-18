import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../../auth/session';
import { can } from '../../../../auth/roles';
import { findProduct, segmentMembers } from '../../../../data/products';
import { findTemplate } from '../../../../data/templates';
import { listCards, draftVersion } from '../../../../data/rate-cards';
import { listCustomers } from '../../../../data/customers';
import { chargeLibrary } from '../../../../domain/charge-library';
import { summariseProduct, productTerms } from '../../../../domain/products';
import { summariseTemplate } from '../../../../domain/templates';
import ApplyProductPanel from '../../../../components/console/ApplyProductPanel';

/**
 * One product: what it is made of, and who it can be sold to.
 *
 * The page answers the question a salesperson asks before quoting — "what does E-commerce
 * parcel actually give them" — by showing the terms it would write, not the references it
 * holds. Everything on it is derived from the template and the charge library at read
 * time, so a product cannot show one thing here and write another on apply.
 */
export default async function ProductPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const user = await currentUser();
  if (!user) notFound();

  const product = await findProduct(key);
  if (!product) notFound();

  const [template, cards, customers] = await Promise.all([
    findTemplate(product.templateKey),
    listCards(),
    listCustomers(),
  ]);
  const drafts = await Promise.all(cards.map((card) => draftVersion(card.key)));

  const library = chargeLibrary(
    drafts.map((draft) => draft.data),
    customers.map((customer) => customer.liveTerms.overrides),
  );
  const summary = summariseProduct(product, template, library);
  const canEdit = can(user.role, 'edit-draft');

  const members = await segmentMembers(product);
  const on = customers.filter((customer) => customer.appliedProduct?.key === product.key);

  // What applying it would actually write, assembled the same way the apply path does.
  const terms = template ? productTerms(product, template) : null;
  const templateSummary = template ? summariseTemplate(template) : null;

  const compatible = customers.filter(
    (customer) => template && customer.baseCardKey === template.baseCardKey,
  );

  return (
    <div className="page">
      <div className="page-inner">
        <p style={{ margin: 0 }}>
          <Link href="/products">← Products</Link>
        </p>
        <h2>{product.name}</h2>
        <p className="lede">
          {product.description ||
            'No description. A product is easier to sell when it says what it is for.'}
        </p>

        {summary.blockers.length > 0 && (
          <div className="panel">
            {summary.blockers.map((blocker) => (
              <div key={blocker} className="error">
                {blocker}
              </div>
            ))}
          </div>
        )}

        <div className="stats">
          <div className="stat">
            <div className="k">Priced from</div>
            <div className="v" style={{ fontSize: 16 }}>
              {summary.templateName ?? product.templateKey}
            </div>
            <div className="sub">{summary.baseCardKey ?? 'no base card'}</div>
          </div>
          <div className="stat">
            <div className="k">Terms it writes</div>
            <div className="v">{terms ? Object.keys(terms.overrides).length : 0}</div>
            <div className="sub">
              {summary.rateCells} rate cells · {summary.charges.length} charges switched on
            </div>
          </div>
          <div className="stat">
            <div className="k">Segment</div>
            <div className={product.segment ? 'v' : 'v muted'} style={{ fontSize: 16 }}>
              {product.segment ?? 'nobody'}
            </div>
            <div className="sub">
              {members.length} customer{members.length === 1 ? '' : 's'} tagged
            </div>
          </div>
          <div className="stat">
            <div className="k">Already on it</div>
            <div className={on.length ? 'v' : 'v muted'}>{on.length}</div>
          </div>
        </div>

        <div className="two-col">
          <div className="panel">
            <h3>Coverage</h3>
            <table className="data">
              <tbody>
                <tr>
                  <td>Modes</td>
                  <td>
                    {summary.modes ? summary.modes.join(', ') : 'Every mode the card carries'}
                    {product.modes && (
                      <span className="chip" style={{ marginLeft: 6 }}>
                        set by the product
                      </span>
                    )}
                  </td>
                </tr>
                <tr>
                  <td>Lanes</td>
                  <td>
                    {templateSummary?.lanes != null
                      ? `${templateSummary.lanes} named lanes`
                      : 'Everywhere the card is served'}
                  </td>
                </tr>
                <tr>
                  <td>Weight bands</td>
                  <td>
                    {template?.scope.weightBands
                      ? `${template.scope.weightBands.length} bands`
                      : 'Every band'}
                  </td>
                </tr>
              </tbody>
            </table>
            <p style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
              Coverage comes from the template unless the product narrows the modes. Narrowing it
              further — a state, a district, a metro group — is the same lane rule editor a contract
              uses, on the customer once the product is applied.
            </p>
          </div>

          <div className="panel">
            <h3>Charges that ride along</h3>
            {summary.charges.length === 0 && summary.unknownCharges.length === 0 ? (
              <div className="empty">
                None attached. The customer carries whatever the base card already switches on.
              </div>
            ) : (
              <table className="data">
                <tbody>
                  {summary.charges.map((charge) => {
                    const entry = library.find((item) => item.id === charge.id);
                    return (
                      <tr key={charge.id}>
                        <td>
                          <strong>{charge.name}</strong>
                        </td>
                        <td style={{ color: 'var(--ink-soft)' }}>{entry?.basis}</td>
                        <td>
                          <span className="chip">
                            {entry?.gstApplies === false ? 'outside GST' : 'in GST'}
                          </span>{' '}
                          {entry?.fuelApplies ? <span className="chip">fuel</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                  {summary.unknownCharges.map((id) => (
                    <tr key={id}>
                      <td colSpan={3}>
                        <span className="chip rejected">{id}</span> nothing defines this
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
              Attaching switches a charge on. Its amount stays on the card or the contract where it
              is defined, so two products cannot disagree about what a COD collection costs.
            </p>
          </div>
        </div>

        <h3>What the rates come from</h3>
        {templateSummary ? (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Area</th>
                  <th style={{ textAlign: 'right' }}>Cells</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(templateSummary.byArea).map(([area, count]) => (
                  <tr key={area}>
                    <td>{area}</td>
                    <td className="num">{count}</td>
                  </tr>
                ))}
                {templateSummary.negotiatedCells === 0 && (
                  <tr>
                    <td colSpan={2}>
                      The template negotiates nothing, so this product sells the base card at
                      standard prices — which is a legitimate product, and worth knowing.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">No template, so there are no rates to show.</p>
        )}

        {canEdit ? (
          <ApplyProductPanel
            productKey={product.key}
            customers={compatible.map((customer) => ({ code: customer.code, name: customer.name }))}
            segment={product.segment ?? null}
            segmentSize={members.length}
            blocked={
              summary.blockers.length > 0
                ? 'Fix what is listed above first. Applying a product that names something missing ' +
                  'writes terms nobody intended.'
                : compatible.length === 0
                  ? `No customer is priced from ${summary.baseCardKey}, so this product has nobody it can be written onto.`
                  : null
            }
          />
        ) : (
          <p className="empty">Your role can read the catalog but not apply from it.</p>
        )}

        {on.length > 0 && (
          <>
            <h3>Customers on this product</h3>
            <table className="data">
              <tbody>
                {on.map((customer) => (
                  <tr key={customer.code}>
                    <td className="ref">
                      <Link href={`/customers/${encodeURIComponent(customer.code)}`}>
                        {customer.code}
                      </Link>
                    </td>
                    <td>{customer.name}</td>
                    <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                      {customer.appliedProduct?.mode === 'replace' ? 'overwritten' : 'gaps filled'}{' '}
                      by {customer.appliedProduct?.appliedBy} ·{' '}
                      {customer.appliedProduct
                        ? new Date(customer.appliedProduct.appliedAt).toLocaleDateString('en-IN')
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
              A record of provenance, not a live link. A contract is free to diverge afterwards, and
              usually does.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
