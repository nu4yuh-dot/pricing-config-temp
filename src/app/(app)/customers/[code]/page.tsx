import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../../auth/session';
import { can } from '../../../../auth/roles';
import { findCustomer, baseCardFor, listCustomers, hasEverProposed } from '../../../../data/customers';
import { listCards } from '../../../../data/rate-cards';
import { listProducts } from '../../../../data/products';
import { effectiveCard, overrideCount } from '../../../../customers/contract';
import { laneRecord, previewParams } from '../../../../console/lanes';
import LaneEditor from '../../../../components/console/LaneEditor';
import ScopeEditor from '../../../../components/console/ScopeEditor';
import ContractChargesEditor from '../../../../components/console/ContractChargesEditor';
import ContractDraftBar from '../../../../components/console/ContractDraftBar';
import CompanyProfileForm from '../../../../components/console/CompanyProfileForm';
import ApplyTemplatePanel from '../../../../components/console/ApplyTemplatePanel';
import SegmentTagsEditor from '../../../../components/console/SegmentTagsEditor';
import PriceLockPanel from '../../../../components/console/PriceLockPanel';
import ChangeSetupPanel from '../../../../components/console/ChangeSetupPanel';
import { priceLockOverrides } from '../../../../domain/price-lock';
import CsvImportPanel from '../../../../components/console/CsvImportPanel';
import { listTemplates } from '../../../../data/templates';
import { summariseTemplate } from '../../../../domain/templates';
import { scoreTemplateFit, templateConflicts } from '../../../../domain/template-fit';
import { editableCellIndex } from '../../../../changes/diff';
import { EMPTY_PROFILE } from '../../../../domain/company';
import { commercialTerms } from '../../../../domain/customers';
import { CSV_TEMPLATE } from '../../../../customers/csv';
import BillingPanel from '../../../../components/console/BillingPanel';
import TaxChargesEditor from '../../../../components/console/TaxChargesEditor';
import {
  modeTaxRows,
  fuelBaseRows,
  chargeRows,
  essZoneRows,
} from '../../../../console/settlement-fields';
import { billingFor } from '../../../../data/billing';
import {
  saveContractLaneEdits,
  saveContractScope,
  saveContractCharges,
} from '../../../../app/console-actions';

export default async function CustomerContractPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const user = await currentUser();
  if (!user) notFound();

  const customer = await findCustomer(code);
  if (!customer) notFound();

  const base = await baseCardFor(customer);

  // Credit terms come from the contract; a customer with none is treated as prepaid, which
  // is the safe reading — no terms agreed means no credit extended.
  const terms = commercialTerms(customer.commercial);
  const billing = await billingFor(customer.code, {
    creditLimit: terms.creditLimit,
    paymentTermsDays: terms.paymentTermsDays,
  });

  const allTemplates = await listTemplates();
  // Labels come from the sheet specs, so a parameter or a conflict reads as "Surface Rates
  // · tier 1 · PNQ→NCR" rather than as a bind path.
  const labels = editableCellIndex(base.data);
  const labelOf = (bind: string) => labels.get(bind)?.label ?? bind;

  // A template written against a different base card would not mean the same thing.
  const templates = allTemplates
    .filter((t) => t.baseCardKey === customer.baseCardKey)
    .map((t) => {
      const fit = scoreTemplateFit(t, {
        baseCardKey: customer.baseCardKey,
        overrides: customer.draftTerms.overrides,
      });
      return {
        key: t.key,
        name: t.name,
        description: t.description,
        cells: summariseTemplate(t).negotiatedCells,
        parameters: (t.parameters ?? []).map((bind) => ({
          bind,
          label: labelOf(bind),
          example: t.overrides[bind] ?? null,
        })),
        conflicts: templateConflicts(t, customer.draftTerms.overrides).map((conflict) => ({
          ...conflict,
          label: labelOf(conflict.bind),
        })),
        agreement: fit.agreement,
        agreeing: fit.agreeing,
      };
    })
    .sort((a, b) => (b.agreement ?? -1) - (a.agreement ?? -1) || b.agreeing - a.agreeing);

  // Segments already in use anywhere, so this customer is offered the existing spelling
  // rather than inventing a fourth one nobody's product matches.
  const [everyone, products] = await Promise.all([listCustomers(), listProducts()]);
  const knownTags = [
    ...new Set([
      ...everyone.flatMap((entry) => entry.tags ?? []),
      ...products.flatMap((product) => (product.segment ? [product.segment] : [])),
    ]),
  ].sort();

  // The escape hatch stays open only while the setup means nothing: no negotiated cell on
  // either side, and never through approval.
  const untouched =
    Object.keys(customer.liveTerms.overrides).length === 0 &&
    Object.keys(customer.draftTerms.overrides).length === 0 &&
    !customer.pendingProposalId &&
    !(await hasEverProposed(customer.code));
  const cards = untouched ? await listCards() : [];

  const liveContract = effectiveCard(base, customer.liveTerms);
  const draftContract = effectiveCard(base, customer.draftTerms);

  const frozen = Boolean(customer.pendingProposalId);
  const canEdit = can(user.role, 'edit-draft') && !frozen;

  const liveSummary = overrideCount(customer.liveTerms.overrides);
  const draftSummary = overrideCount(customer.draftTerms.overrides);
  const outstanding = Object.entries(customer.draftTerms.overrides).filter(
    ([path, value]) => customer.liveTerms.overrides[path] !== value,
  ).length;
  const scopeChanged =
    JSON.stringify(customer.liveTerms.scope) !== JSON.stringify(customer.draftTerms.scope);

  return (
    <div className="page">
      <div className="page-inner">
        <p style={{ margin: 0 }}>
          <Link href="/customers" style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
            ← All customers
          </Link>
        </p>
        <h2>
          {customer.name}{' '}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--ink-faint)' }}>
            {customer.code}
          </span>
        </h2>

        {/* What prices this customer, said plainly — the first thing anyone asks of a
            contract, and a pile of override cells does not answer it. */}
        <table className="data" style={{ marginBottom: 14, maxWidth: 720 }}>
          <tbody>
            <tr>
              <td style={{ width: 150 }}>Priced from</td>
              <td>
                <strong>{base.name}</strong>{' '}
                <span style={{ color: 'var(--ink-faint)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {base.freightMethod}
                </span>
              </td>
            </tr>
            <tr>
              <td>Template</td>
              <td>
                {customer.appliedTemplate ? (
                  <>
                    <Link href={`/templates/${customer.appliedTemplate.key}`}>
                      {customer.appliedTemplate.name}
                    </Link>{' '}
                    <span style={{ color: 'var(--ink-faint)' }}>
                      · applied {customer.appliedTemplate.mode === 'replace' ? 'wholesale' : 'over gaps'} by{' '}
                      {customer.appliedTemplate.appliedBy} on{' '}
                      {new Date(customer.appliedTemplate.appliedAt).toISOString().slice(0, 10)}
                      {' '}— the contract may have moved since
                    </span>
                  </>
                ) : (
                  <span style={{ color: 'var(--ink-faint)' }}>
                    None — negotiated directly, or still on standard rates
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="lede">
          Priced from <strong>{base.name}</strong>, with only the negotiated cells stored. Everything
          not negotiated follows the base card automatically — including future changes to it.
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">Negotiated cells</div>
            <div className={liveSummary.total === 0 ? 'v muted' : 'v'}>{liveSummary.total}</div>
            <div className="sub">
              {liveSummary.total === 0
                ? 'Standard prices throughout'
                : Object.entries(liveSummary.byArea)
                    .map(([area, count]) => `${area} ${count}`)
                    .join(' · ')}
            </div>
          </div>
          <div className="stat">
            <div className="k">Stored instead of</div>
            <div className="v">4,104</div>
            <div className="sub">Cells a full copy would need</div>
          </div>
          <div className="stat">
            <div className="k">Contract covers</div>
            <div className="v" style={{ fontSize: 15 }}>
              {customer.liveTerms.scope.lanes === null
                ? 'All lanes'
                : `${customer.liveTerms.scope.lanes.length} lanes`}
            </div>
            <div className="sub">
              {customer.liveTerms.scope.modes === null
                ? 'All modes'
                : customer.liveTerms.scope.modes.join(', ')}
            </div>
          </div>
          <div className="stat">
            <div className="k">Source</div>
            <div className="v" style={{ fontSize: 15 }}>
              {customer.source === 'api' ? 'Booking site' : 'Added here'}
            </div>
            <div className="sub">{new Date(customer.createdAt).toLocaleDateString('en-IN')}</div>
          </div>
        </div>

        <ContractDraftBar
          customerCode={customer.code}
          outstandingCount={outstanding}
          scopeChanged={scopeChanged}
          frozen={frozen}
          {...(customer.pendingProposalId
            ? { pendingProposalId: customer.pendingProposalId.toHexString() }
            : {})}
        />

        <h3>Set the whole contract at once</h3>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Two ways to avoid building a contract lane by lane. Both land in the draft, so both still
          go through approval.
        </p>
        <ApplyTemplatePanel
          customerCode={customer.code}
          templates={templates}
          hasOwnTerms={draftSummary.total > 0}
          canEdit={canEdit}
        />
        {untouched && can(user.role, 'edit-draft') && (
          <ChangeSetupPanel
            customerCode={customer.code}
            baseCardKey={customer.baseCardKey}
            cards={cards.map((card) => ({ key: card.key, name: card.name }))}
          />
        )}

        <PriceLockPanel
          customerCode={customer.code}
          lockedCount={Object.keys(customer.draftTerms.priceLock?.rates ?? {}).length}
          lockedAt={
            customer.draftTerms.priceLock
              ? new Date(customer.draftTerms.priceLock.at).toLocaleDateString('en-IN')
              : null
          }
          lockedBy={customer.draftTerms.priceLock?.by ?? null}
          lockableCount={Object.keys(priceLockOverrides(base.data, customer.draftTerms.overrides)).length}
          canEdit={canEdit}
        />
        <SegmentTagsEditor
          customerCode={customer.code}
          tags={customer.tags ?? []}
          known={knownTags}
          canEdit={canEdit}
        />
        <CsvImportPanel
          customerCode={customer.code}
          templateCsv={CSV_TEMPLATE}
          canEdit={canEdit}
        />

        <h3>Negotiated rates</h3>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Green means this customer already has a negotiated value on that field. Leaving a field at
          the base value stores nothing at all.
        </p>

        <LaneEditor
          lanes={laneRecord(draftContract.data)}
          baseline={laneRecord(base.data)}
          freightMethod={base.freightMethod}
          minWeightAir={draftContract.data.charges.minWeightAir}
          minWeightSurface={draftContract.data.charges.minWeightSurface}
          preview={previewParams(draftContract.data)}
          canEdit={canEdit}
          baselineLabel="standard"
          onSave={async (edits) => {
            'use server';
            await saveContractLaneEdits(customer.code, edits);
          }}
        />

        <h3>Negotiated charges</h3>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Fuel, GST, docket, cartage and ODA can all be negotiated per customer, not just lane
          rates. As with rates, only what differs from standard is stored.
        </p>
        <ContractChargesEditor
          contract={draftContract.data}
          base={base.data}
          canEdit={canEdit}
          onSave={async (edits) => {
            'use server';
            await saveContractCharges(customer.code, edits);
          }}
        />

        <h3>What the contract covers</h3>
        <ScopeEditor
          scope={customer.draftTerms.scope}
          canEdit={canEdit}
          onSave={async (scope) => {
            'use server';
            await saveContractScope(customer.code, scope);
          }}
        />

        <h3>Tax, fuel base &amp; other charges</h3>
        <p className="lede" style={{ marginTop: 0 }}>
          Negotiated exactly like a rate: anything left alone keeps tracking the standard card.
          This is where a contract says its fuel rides on <em>total</em> charges rather than on
          freight, switches an express surcharge on and prices it by destination, or puts a mode
          under reverse charge.
        </p>
        <TaxChargesEditor
          modes={modeTaxRows(draftContract.data, base.data)}
          fuelBase={fuelBaseRows(draftContract.data, base.data)}
          charges={chargeRows(draftContract.data, base.data)}
          essZones={essZoneRows(draftContract.data, base.data)}
          scopeNote={`These change the tax and charge lines on ${customer.name}'s quotes only, and go to approval with the rest of the contract.`}
          canEdit={canEdit}
          onSave={async (edits) => {
            'use server';
            await saveContractCharges(customer.code, edits);
          }}
        />

        <h3>Money</h3>
        <BillingPanel
          code={customer.code}
          canRecord={can(user.role, 'record-money')}
          position={billing.position}
          paymentTermsDays={terms.paymentTermsDays}
          statement={billing.statement.map((row) => ({
            id: row.entry.id,
            kind: row.entry.kind,
            reference: row.entry.reference,
            ...(row.entry.against === undefined ? {} : { against: row.entry.against }),
            ...(row.entry.note === undefined ? {} : { note: row.entry.note }),
            at: row.entry.at.toISOString().slice(0, 10),
            amountPaise: row.entry.amountPaise,
            balanceAfter: row.balanceAfter,
          }))}
          invoices={billing.invoices.map((invoice) => ({
            number: invoice.number,
            mode: invoice.mode,
            raisedAt: invoice.raisedAt.toISOString().slice(0, 10),
            lines: invoice.lines.length,
            taxableValuePaise: invoice.taxableValuePaise,
            gstPaise: invoice.gstPaise,
            totalPaise: invoice.totalPaise,
            paidPaise: invoice.paidPaise,
            status: invoice.status,
            sac: invoice.sac,
            gstRate: invoice.gstRate,
            rcm: invoice.rcm,
            ...(invoice.note === undefined ? {} : { note: invoice.note }),
          }))}
        />

        <h3>Company &amp; commercial</h3>
        <CompanyProfileForm
          code={customer.code}
          profile={customer.profile ?? EMPTY_PROFILE}
          commercial={commercialTerms(customer.commercial)}
          canEdit={can(user.role, 'edit-draft')}
        />

        {liveSummary.total > 0 && (
          <>
            <h3>Approved contract terms</h3>
            <div className="scroll-x">
              <table className="data">
                <thead>
                  <tr>
                    <th>Cell</th>
                    <th style={{ textAlign: 'right' }}>Standard</th>
                    <th style={{ textAlign: 'right' }}>Contracted</th>
                    <th style={{ textAlign: 'right' }}>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(customer.liveTerms.overrides).map(([path, value]) => {
                    const readable = path
                      .replace('grids.', '')
                      .replace('.minCharge.', ' · minimum · ')
                      .replace('.tier1.', ' · tier 1 · ')
                      .replace('.tier2.', ' · tier 2 · ')
                      .replace('.tier3.', ' · tier 3 · ')
                      .replace(/\.([A-Z]+)$/, '→$1');
                    const standard = path
                      .split('.')
                      .reduce<unknown>(
                        (acc, seg) =>
                          acc && typeof acc === 'object'
                            ? (acc as Record<string, unknown>)[seg]
                            : undefined,
                        base.data,
                      );
                    const delta =
                      typeof standard === 'number' && typeof value === 'number' && standard !== 0
                        ? ((value - standard) / standard) * 100
                        : null;
                    return (
                      <tr key={path}>
                        <td className="ref">{readable}</td>
                        <td className="num">{String(standard ?? '—')}</td>
                        <td className="num">
                          <strong>{value === null ? 'not served' : String(value)}</strong>
                        </td>
                        <td className="num">
                          {delta === null ? (
                            '—'
                          ) : (
                            <span className={`delta ${delta > 0 ? 'up' : 'down'}`}>
                              {delta > 0 ? '+' : ''}
                              {delta.toFixed(1)}%
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {draftSummary.total !== liveSummary.total && (
          <p style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
            The draft currently holds {draftSummary.total} negotiated cell
            {draftSummary.total === 1 ? '' : 's'} against {liveSummary.total} approved.
          </p>
        )}
      </div>
    </div>
  );
}
