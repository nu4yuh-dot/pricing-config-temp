import Link from 'next/link';
import { listCustomers } from '../../../data/customers';
import { listCards } from '../../../data/rate-cards';
import { overrideCount } from '../../../customers/contract';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import AddCustomerForm from '../../../components/console/AddCustomerForm';

const scopeSummary = (scope: {
  modes: string[] | null;
  lanes: string[] | null;
  weightBands: unknown[] | null;
}): string => {
  const parts: string[] = [];
  if (scope.modes !== null) parts.push(`${scope.modes.length} mode${scope.modes.length === 1 ? '' : 's'}`);
  if (scope.lanes !== null) parts.push(`${scope.lanes.length} lane${scope.lanes.length === 1 ? '' : 's'}`);
  if (scope.weightBands !== null) {
    parts.push(`${scope.weightBands.length} weight band${scope.weightBands.length === 1 ? '' : 's'}`);
  }
  return parts.length === 0 ? 'Everything' : parts.join(' · ');
};

export default async function CustomersPage() {
  const [customers, cards, user] = await Promise.all([listCustomers(), listCards(), currentUser()]);
  const editable = user ? can(user.role, 'edit-draft') : false;

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Contract customers</h2>
        <p className="lede">
          A contract is the base rate card plus only the cells that were negotiated. A customer who
          agreed four lanes stores four values, not a copy of the card — so they keep tracking base
          changes everywhere else automatically.
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">Customers</div>
            <div className="v">{customers.length}</div>
          </div>
          <div className="stat">
            <div className="k">With negotiated rates</div>
            <div className="v">
              {customers.filter((c) => Object.keys(c.liveTerms.overrides).length > 0).length}
            </div>
          </div>
          <div className="stat">
            <div className="k">Restricted contracts</div>
            <div className="v">
              {
                customers.filter(
                  (c) =>
                    c.liveTerms.scope.modes !== null ||
                    c.liveTerms.scope.lanes !== null ||
                    c.liveTerms.scope.weightBands !== null,
                ).length
              }
            </div>
            <div className="sub">Do not cover the whole network</div>
          </div>
          <div className="stat">
            <div className="k">Awaiting approval</div>
            <div className="v">{customers.filter((c) => c.pendingProposalId).length}</div>
          </div>
        </div>

        {customers.length === 0 ? (
          <div className="panel">
            <div className="empty">
              No customers yet. They arrive automatically when the booking site posts to{' '}
              <code>/api/customers</code>, or you can add one below.
            </div>
          </div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Base card</th>
                <th style={{ textAlign: 'right' }}>Negotiated cells</th>
                <th>Contract covers</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => {
                const summary = overrideCount(customer.liveTerms.overrides);
                const draftSummary = overrideCount(customer.draftTerms.overrides);
                const cardName =
                  cards.find((card) => card.key === customer.baseCardKey)?.name ??
                  customer.baseCardKey;
                return (
                  <tr key={customer.code}>
                    <td className="ref">
                      <strong>{customer.code}</strong>
                    </td>
                    <td>{customer.name}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>{cardName}</td>
                    <td className="num">
                      {summary.total === 0 ? (
                        <span style={{ color: 'var(--ink-faint)' }}>none</span>
                      ) : (
                        <span title={JSON.stringify(summary.byArea)}>{summary.total}</span>
                      )}
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      {scopeSummary(customer.liveTerms.scope)}
                    </td>
                    <td>
                      {customer.pendingProposalId ? (
                        <span className="chip pending">proposal pending</span>
                      ) : draftSummary.total !== summary.total ? (
                        <span className="chip draft">draft</span>
                      ) : (
                        <span className="chip live">live</span>
                      )}
                    </td>
                    <td>
                      <Link className="btn" // Encoded: a code with a space in it — "SANDVIK PUNE" — breaks the URL otherwise
                        // and the page 404s.
                        href={`/customers/${encodeURIComponent(customer.code)}`}>
                        {editable ? 'Open contract' : 'View'}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {editable && (
          <>
            <h3>Add a customer</h3>
            <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
              New customers normally arrive from the booking website. To set one up properly —
              identity, a starting pricing pattern and coverage, in four steps — use{' '}
              <Link href="/customers/new">the wizard</Link>. The quick form below does what it
              always did: a record on the base card at standard prices, nothing negotiated.
            </p>
            <AddCustomerForm cards={cards.map((card) => ({ key: card.key, name: card.name }))} />
          </>
        )}
      </div>
    </div>
  );
}
