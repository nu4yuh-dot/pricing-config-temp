import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../../auth/session';
import { can } from '../../../../auth/roles';
import { findTemplate } from '../../../../data/templates';
import { liveCard } from '../../../../data/rate-cards';
import { effectiveCard, overrideCount } from '../../../../customers/contract';
import { laneRecord, previewParams } from '../../../../console/lanes';
import LaneEditor from '../../../../components/console/LaneEditor';
import ContractChargesEditor from '../../../../components/console/ContractChargesEditor';
import ScopeEditor from '../../../../components/console/ScopeEditor';
import { saveTemplateTerms } from '../../../../app/console-actions';
import { EMPTY_TERMS } from '../../../../domain/customers';
import { summariseTemplate } from '../../../../domain/templates';
import TemplateParametersEditor from '../../../../components/console/TemplateParametersEditor';
import { editableCellIndex } from '../../../../changes/diff';
import { listCustomers } from '../../../../data/customers';

/**
 * Editing a template.
 *
 * A template is a rate card plus the cells that differ from it — the same shape as a
 * contract — so the contract editors work on one unchanged. That is the point: there is
 * one way to express negotiated pricing in this system, and a template is it, saved under
 * a name instead of against a customer.
 *
 * Unlike a contract there is no approval step here. A template prices nothing on its own;
 * it only takes effect when assigned to a customer, and that assignment lands in their
 * draft and goes through the usual review.
 */
export default async function TemplatePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const user = await currentUser();
  if (!user) notFound();

  const template = await findTemplate(key);
  if (!template) notFound();

  const base = await liveCard(template.baseCardKey);
  if (!base) notFound();

  const canEdit = can(user.role, 'edit-draft');

  // The template applied over its base card: what a customer assigned this would get.
  const effective = effectiveCard(base, {
    ...EMPTY_TERMS,
    overrides: template.overrides,
    scope: template.scope,
  });
  const summary = overrideCount(template.overrides);
  const shape = summariseTemplate(template);

  // Labelled through the sheet specs, so a field reads the way the approval queue reads it.
  const labels = editableCellIndex(base.data);
  const fields = Object.entries(template.overrides).map(([bind, value]) => ({
    bind,
    label: labels.get(bind)?.label ?? bind,
    value,
  }));

  // Provenance, the other direction: a template's worth is how many contracts came off it.
  const assigned = (await listCustomers()).filter(
    (customer) => customer.appliedTemplate?.key === template.key,
  );

  return (
    <div className="page">
      <div className="page-inner">
        <h2>{template.name}</h2>
        <p className="lede">
          {template.description || 'No description.'} Written against{' '}
          <strong>{base.name}</strong> · {summary.total} negotiated{' '}
          {summary.total === 1 ? 'cell' : 'cells'}
          {template.derivedFromCustomer && <> · copied from {template.derivedFromCustomer}</>} ·{' '}
          <Link href="/templates">← all templates</Link>
        </p>

        {summary.total === 0 && (
          <div className="callout">
            <strong>Nothing is negotiated yet</strong>
            Assigned as it stands, this template would change no price. Set the rates it should
            carry below; anything left alone keeps tracking the standard card, which is usually
            what you want.
          </div>
        )}

        <div className="callout info">
          <strong>A template prices nothing on its own</strong>
          It takes effect only when assigned to a customer, and that assignment lands in their
          draft and goes through the same review as any other change. Editing here needs no
          approval for the same reason.
        </div>

        <TemplateParametersEditor
          templateKey={key}
          fields={fields}
          parameters={template.parameters ?? []}
          canEdit={canEdit}
        />

        <h3>Contracts built from this</h3>
        {assigned.length === 0 ? (
          <p className="empty">
            Nobody yet. A template earns its place the second time it is used, not the first.
          </p>
        ) : (
          <table className="data">
            <tbody>
              {assigned.map((customer) => (
                <tr key={customer.code}>
                  <td className="ref">
                    <Link href={`/customers/${encodeURIComponent(customer.code)}`}>
                      {customer.code}
                    </Link>
                  </td>
                  <td>{customer.name}</td>
                  <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                    {customer.appliedTemplate?.mode === 'replace' ? 'wholesale' : 'over gaps'} by{' '}
                    {customer.appliedTemplate?.appliedBy} ·{' '}
                    {customer.appliedTemplate
                      ? new Date(customer.appliedTemplate.appliedAt).toLocaleDateString('en-IN')
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3>Lane rates</h3>
        <LaneEditor
          lanes={laneRecord(effective.data)}
          baseline={laneRecord(base.data)}
          freightMethod={base.freightMethod}
          minWeightAir={effective.data.charges.minWeightAir}
          minWeightSurface={effective.data.charges.minWeightSurface}
          preview={previewParams(effective.data)}
          canEdit={canEdit}
          baselineLabel="standard"
          onSave={async (edits) => {
            'use server';
            const { bindPathFor } = await import('../../../../console/lanes');
            await saveTemplateTerms(
              key,
              edits.map((edit) => ({
                bind: bindPathFor(edit.mode, edit.rate, edit.origin, edit.destination),
                value: edit.value,
              })),
            );
          }}
        />

        <h3>Charges &amp; weight rules</h3>
        <ContractChargesEditor
          contract={effective.data}
          base={base.data}
          canEdit={canEdit}
          onSave={async (edits) => {
            'use server';
            await saveTemplateTerms(key, edits);
          }}
        />

        <h3>What it covers</h3>
        <p className="hint" style={{ marginTop: 0 }}>
          {shape.restricted
            ? `Restricted: ${shape.modes ? shape.modes.join(', ') : 'all modes'}${
                shape.lanes === null ? '' : `, ${shape.lanes} lane(s)`
              }. A customer assigned this can only book inside it.`
            : 'Unrestricted — every mode, lane and weight the base card serves.'}
        </p>
        <ScopeEditor
          scope={template.scope}
          canEdit={canEdit}
          onSave={async (scope) => {
            'use server';
            await saveTemplateTerms(key, [], scope);
          }}
        />
      </div>
    </div>
  );
}
