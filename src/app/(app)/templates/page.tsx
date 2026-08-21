import Link from 'next/link';
import { listTemplates } from '../../../data/templates';
import { listCustomers } from '../../../data/customers';
import { listCards } from '../../../data/rate-cards';
import { summariseTemplate } from '../../../domain/templates';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import NewTemplateForm from '../../../components/console/NewTemplateForm';
import RowAction from '../../../components/console/RowAction';
import { removeTemplate } from '../../console-actions';

/**
 * Rate templates — a saved configuration you assign instead of rebuilding.
 *
 * A template holds the same sparse override map a contract does, so "save this
 * customer's terms as a template" and "apply this template to that customer" are
 * both copies rather than conversions.
 */
export default async function TemplatesPage() {
  const [templates, customers, cards, user] = await Promise.all([
    listTemplates(),
    listCustomers(),
    listCards(),
    currentUser(),
  ]);
  const editable = user ? can(user.role, 'edit-draft') : false;
  // Deleting demands `manage-users`, not `edit-draft`. Gated on the same capability the
  // action checks — a button that is always refused is worse than no button.
  const canDelete = user ? can(user.role, 'manage-users') : false;

  // What a template is worth: how many contracts were actually built from it.
  const assignedCount = (key: string) =>
    customers.filter((customer) => customer.appliedTemplate?.key === key).length;

  const withTerms = customers.filter(
    (customer) => Object.keys(customer.liveTerms.overrides).length > 0,
  );

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Rate templates</h2>
        <p className="lede">
          Most proposals are a variation on a handful of standard shapes. Save a shape once, assign
          it to a customer, then adjust only what is genuinely bespoke. Applying a template lands in
          the customer&rsquo;s draft, so it still goes through approval.
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">Templates</div>
            <div className={templates.length ? 'v' : 'v muted'}>{templates.length}</div>
          </div>
          <div className="stat">
            <div className="k">Customers with terms</div>
            <div className="v">{withTerms.length}</div>
            <div className="sub">Any of these can become a template</div>
          </div>
        </div>

        {templates.length === 0 ? (
          <div className="panel">
            <div className="empty">
              No templates yet. The quickest way to make one is from a customer whose contract
              already works — pick one below.
            </div>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Base card</th>
                  <th style={{ textAlign: 'right' }}>Cells</th>
                  <th style={{ textAlign: 'right' }}>Asked</th>
                  <th style={{ textAlign: 'right' }}>In use</th>
                  <th>Covers</th>
                  <th>From</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {templates.map((template) => {
                  const summary = summariseTemplate(template);
                  const cardName =
                    cards.find((c) => c.key === template.baseCardKey)?.name ?? template.baseCardKey;
                  return (
                    <tr key={template.key}>
                      <td>
                        <strong>
                          <Link href={`/templates/${template.key}`}>{template.name}</Link>
                        </strong>
                        {template.description && (
                          <div style={{ color: 'var(--ink-soft)', fontSize: 11.5 }}>
                            {template.description}
                          </div>
                        )}
                      </td>
                      <td style={{ color: 'var(--ink-soft)' }}>{cardName}</td>
                      <td className="num">{summary.negotiatedCells}</td>
                      <td className="num">
                        {(template.parameters ?? []).length === 0 ? (
                          <span style={{ color: 'var(--ink-faint)' }}>all fixed</span>
                        ) : (
                          `${template.parameters?.length} parameters`
                        )}
                      </td>
                      <td className="num">
                        {assignedCount(template.key) === 0 ? (
                          <span style={{ color: 'var(--ink-faint)' }}>none</span>
                        ) : (
                          `${assignedCount(template.key)} contract${assignedCount(template.key) === 1 ? '' : 's'}`
                        )}
                      </td>
                      <td style={{ color: 'var(--ink-soft)' }}>
                        {summary.restricted
                          ? `${summary.lanes ?? 'all'} lanes · ${summary.modes?.join(', ') ?? 'all modes'}`
                          : 'Everything'}
                      </td>
                      <td className="ref">
                        {template.derivedFromCustomer ? (
                          <Link href={`/customers/${encodeURIComponent(template.derivedFromCustomer)}`}>
                            {template.derivedFromCustomer}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                        {template.createdBy} ·{' '}
                        {new Date(template.createdAt).toLocaleDateString('en-IN')}
                      </td>
                      <td>
                        {canDelete && (
                          <RowAction
                            label="Delete"
                            danger
                            /**
                             * The confirm names what is lost. Contracts built from a template
                             * keep their rates — the terms were copied, not referenced — but
                             * they cite it as where they came from, and that citation stops
                             * resolving.
                             */
                            confirmLabel={
                              assignedCount(template.key) === 0
                                ? `Delete ${template.name}`
                                : `Delete anyway — ${assignedCount(template.key)} contract${
                                    assignedCount(template.key) === 1 ? '' : 's'
                                  } cite${assignedCount(template.key) === 1 ? 's' : ''} it`
                            }
                            run={async () => {
                              'use server';
                              await removeTemplate(template.key);
                            }}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
          To assign a template, open a customer and use <strong>Start from a template</strong> on
          their contract page.
        </p>

        {editable && (
          <>
            <h3>New template</h3>
            <NewTemplateForm
              customers={withTerms.map((c) => ({
                code: c.code,
                name: c.name,
                cells: Object.keys(c.liveTerms.overrides).length,
              }))}
              // DNS cards only. A template is edited with the lane and charge editors,
              // and Bluedart has no lane matrices at all — offering it would open an
              // editor that shows every lane as "not carried", which is not true and not
              // fixable there. Bluedart templates need their own editor first.
              cards={cards
                .filter((card) => (card.source ?? 'dns') === 'dns')
                .map((card) => ({ key: card.key, name: card.name }))}
            />
          </>
        )}
      </div>
    </div>
  );
}
