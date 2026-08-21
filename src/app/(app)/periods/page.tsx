import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import { listPeriods } from '../../../data/billing-periods';
import ReopenPeriodForm from '../../../components/console/ReopenPeriodForm';
import { reopenPeriodAction, relockPeriodAction } from '../../console-actions';
import { disputedLines } from '../../../data/billing-periods';
import { reopeningProposals } from '../../../billing/disputes';
import {
  PERIOD_STATE_LABELS,
  isFrozen,
  restatementNote,
  restatementHistory,
  netRestatementPaise,
} from '../../../billing/periods';

/**
 * Billing periods — what each bill covered, and whether it can still change.
 *
 * A period is a claim: that these shipments were billed for August, at these amounts, and
 * that the total was agreed. Once a customer has the bill, the set must not quietly acquire
 * another shipment — which is what freezing prevents.
 *
 * A frozen period can still be corrected, but only deliberately: somebody reopens it and
 * says why, and what the bill said before is kept. That pair — as billed against as
 * corrected — is the reason these are states rather than a boolean.
 */
export default async function PeriodsPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!can(user.role, 'record-money')) redirect('/console/model-1/rates');

  const periods = await listPeriods();
  /**
   * Reopenings the customer has effectively asked for.
   *
   * A dispute is raised in the core's enterprise portal and reaches us on the shipment
   * update. Waiting for somebody here to notice is how a disputed line sits on an ageing
   * report for a month pretending to be a collection problem.
   */
  const proposals = reopeningProposals(await disputedLines(), periods);
  const proposalFor = (customerCode: string, from: Date) =>
    proposals.find(
      (proposal) =>
        proposal.customerCode === customerCode &&
        proposal.periodFrom.getTime() === from.getTime(),
    );
  const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;
  const corrected = periods.filter((period) => period.restatements.length > 0);

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Billing periods</h2>
        <p className="lede">
          What each bill covered, and whether the set is still open. A billed period is frozen
          — a late shipment goes into the open period, or somebody reopens this one and says
          why.
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">Periods</div>
            <div className="v">{periods.length}</div>
          </div>
          <div className="stat">
            <div className="k">Open</div>
            <div className="v">{periods.filter((period) => period.state === 'open').length}</div>
            <div className="sub">Shipments still landing</div>
          </div>
          <div className="stat">
            <div className="k">Being corrected</div>
            <div className={periods.some((p) => p.state === 'reopened') ? 'v' : 'v muted'}>
              {periods.filter((period) => period.state === 'reopened').length}
            </div>
          </div>
          <div className="stat">
            <div className="k">Restated</div>
            <div className={corrected.length ? 'v' : 'v muted'}>{corrected.length}</div>
            <div className="sub">Billed, then corrected</div>
          </div>
        </div>

        {periods.length === 0 ? (
          <p className="empty">
            No periods yet. One opens the first time a shipment is attributed to a window.
          </p>
        ) : (
          <div className="gridscroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Period</th>
                  <th>State</th>
                  <th style={{ textAlign: 'right' }}>Invoices</th>
                  <th style={{ textAlign: 'right' }}>As billed</th>
                  <th>Restatement</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => {
                  const net = netRestatementPaise(period);
                  const latest = restatementHistory(period).at(-1);
                  return (
                    <tr key={`${period.customerCode}-${period.from.toISOString()}`}>
                      <td>
                        <Link href={`/customers/${period.customerCode}`}>
                          {period.customerCode}
                        </Link>
                      </td>
                      <td>
                        {period.from.toLocaleDateString('en-IN', { dateStyle: 'medium' })} –{' '}
                        {period.to.toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                      </td>
                      <td>
                        <span className={`chip ${isFrozen(period.state) ? 'live' : 'draft'}`}>
                          {period.state}
                        </span>
                        <div className="sub">{PERIOD_STATE_LABELS[period.state]}</div>
                      </td>
                      <td className="num">{period.invoiceNumbers.length}</td>
                      <td className="num">
                        {period.asBilledPaise === undefined ? '—' : rupees(period.asBilledPaise)}
                      </td>
                      <td>
                        {proposalFor(period.customerCode, period.from) && (
                          <div className="callout warn" style={{ margin: '0 0 6px' }}>
                            <strong>
                              Customer disputed ₹
                              {(
                                proposalFor(period.customerCode, period.from)!.disputedAmount
                              ).toLocaleString('en-IN')}
                            </strong>
                            <div className="sub">
                              {proposalFor(period.customerCode, period.from)!.lines.length} line(s).
                              Reopening is suggested.
                            </div>
                          </div>
                        )}
                        {latest ? (
                          <>
                            {restatementNote(latest)}
                            {period.restatements.length > 1 && (
                              <div className="sub">
                                {period.restatements.length} corrections · net{' '}
                                {net > 0 ? '+' : ''}
                                {rupees(net)} against the original
                              </div>
                            )}
                          </>
                        ) : (
                          !proposalFor(period.customerCode, period.from) && (
                            <span className="muted">—</span>
                          )
                        )}
                      </td>
                      <td>
                        <ReopenPeriodForm
                          reopen={reopenPeriodAction}
                          relock={relockPeriodAction}
                          customerCode={period.customerCode}
                          from={period.from.toISOString()}
                          state={period.state}
                          {...(proposalFor(period.customerCode, period.from)
                            ? {
                                suggestedReason: proposalFor(
                                  period.customerCode,
                                  period.from,
                                )!.suggestedReason,
                              }
                            : {})}
                          {...(period.asBilledPaise === undefined
                            ? {}
                            : { asBilled: period.asBilledPaise })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
