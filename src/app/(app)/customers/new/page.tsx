import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../../auth/session';
import { can } from '../../../../auth/roles';
import { listCards, liveVersion } from '../../../../data/rate-cards';
import { listCustomers } from '../../../../data/customers';
import { listTemplates } from '../../../../data/templates';
import { editableCellIndex } from '../../../../changes/diff';
import CustomerWizard from '../../../../components/console/CustomerWizard';

/**
 * Adding a customer, as four questions rather than one form and a blank grid.
 *
 * The old path recorded a customer in seconds and then left somebody in front of a 21×21
 * matrix with no guidance, which is where the real work was. This asks who they are, what
 * they should be priced like, what the contract covers, and then shows what it is about to
 * create — before anything is written.
 */
export default async function NewCustomerPage() {
  const user = await currentUser();
  if (!user) notFound();
  if (!can(user.role, 'edit-draft')) notFound();

  const [cards, customers, templates] = await Promise.all([
    listCards(),
    listCustomers(),
    listTemplates(),
  ]);

  // Parameter labels come from the sheet specs of the card the template is written
  // against, so each asks for "Surface Rates · tier 1 · PNQ→NCR" rather than a bind path.
  const labelIndexes = new Map<string, Map<string, { label: string }>>();
  for (const card of cards) {
    const live = await liveVersion(card.key);
    labelIndexes.set(card.key, editableCellIndex(live.data));
  }

  return (
    <div className="page">
      <div className="page-inner">
        <p style={{ margin: 0 }}>
          <Link href="/customers">← All customers</Link>
        </p>
        <h2>New customer</h2>
        <p className="lede">
          Four steps to a contract somebody could propose, instead of a record and a blank
          matrix. Every step lands through the ordinary machinery — a template assignment here
          is the same assignment as on the contract page — so nothing about the result is
          special afterwards.
        </p>

        <CustomerWizard
          cards={cards.map((card) => ({
            key: card.key,
            name: card.name,
            method: (card.source ?? 'dns') === 'bluedart' ? 'directional zones' : card.freightMethod,
          }))}
          templates={templates.map((template) => ({
            key: template.key,
            name: template.name,
            description: template.description,
            baseCardKey: template.baseCardKey,
            cells: Object.keys(template.overrides).length,
            usedBy: customers.filter((customer) => customer.appliedTemplate?.key === template.key)
              .length,
            parameters: (template.parameters ?? []).map((bind) => ({
              bind,
              label: labelIndexes.get(template.baseCardKey)?.get(bind)?.label ?? bind,
              example: template.overrides[bind] ?? null,
            })),
          }))}
          customers={customers.map((customer) => ({
            code: customer.code,
            name: customer.name,
            baseCardKey: customer.baseCardKey,
            cells: Object.keys(customer.liveTerms.overrides).length,
          }))}
        />
      </div>
    </div>
  );
}
