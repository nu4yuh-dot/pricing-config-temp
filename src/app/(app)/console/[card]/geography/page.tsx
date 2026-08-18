import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { draftVersion, findCard } from '../../../../../data/rate-cards';
import { canEditDraft } from '../../../../../data/workflow';
import { orderRules } from '../../../../../domain/lane-rules';
import { rulesFrom, newRuleId } from '../../../../../domain/lane-rule-store';
import GeographyRuleEditor from '../../../../../components/console/GeographyRuleEditor';
import RuleCascade from '../../../../../components/console/RuleCascade';
import ShipmentTester from '../../../../../components/console/ShipmentTester';
import {
  saveLaneRule,
  removeLaneRule,
  searchGeographyAction,
  coverageAction,
  previewRuleAction,
  testShipmentAction,
} from '../../../../../app/console-actions';
import type { StoredMode } from '../../../../../domain/types';

const MODES: StoredMode[] = ['surface', 'air', 'rail'];

export default async function GeographyPage({
  params,
  searchParams,
}: {
  params: Promise<{ card: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  const { card: cardKey } = await params;
  const { mode: requested } = await searchParams;
  const user = await currentUser();
  if (!user) notFound();

  const card = await findCard(cardKey);
  if (!card) notFound();

  const draft = await draftVersion(cardKey);
  const canEdit = can(user.role, 'edit-draft') && canEditDraft(draft.state);
  const mode = MODES.includes(requested as StoredMode) ? (requested as StoredMode) : 'surface';

  const stored = draft.data.laneRules ?? {};
  // Rules are read for the mode being configured; the resolver ignores the rest anyway,
  // and showing them in one cascade would imply a precedence that does not exist between
  // an air rule and a surface one.
  const ordered = orderRules(rulesFrom(stored, 'base').filter((rule) => rule.mode === mode)).map(
    (rule) => ({
      ...rule,
      id:
        Object.values(stored).find(
          (candidate) =>
            candidate.mode === rule.mode &&
            candidate.origin.kind === rule.origin.kind &&
            candidate.origin.value === rule.origin.value &&
            candidate.destination.kind === rule.destination.kind &&
            candidate.destination.value === rule.destination.value,
        )?.id ?? '',
    }),
  );

  // Endpoints plus the headline rate, which is all the editor needs to say what a new
  // rule would sit above — not the whole rule, which would ship rates nobody reads.
  const existing = ordered.map((rule) => ({
    origin: rule.origin,
    destination: rule.destination,
    tier1: rule.rates.tier1,
  }));

  return (
    <>
      <h2>Smart geography</h2>
      <p className="lede">
        Price at whatever level the negotiation actually happened at — a pincode, a city, a
        state, a zone, a group like the metros, or everywhere. The most specific rule that
        matches a shipment wins, every pincode underneath resolves automatically, and the
        whole agreement is stored as one rule rather than the hundreds of cells it used to
        expand into.
      </p>

      <div className="tabstrip">
        {MODES.map((option) => (
          <a
            key={option}
            href={`/console/${cardKey}/geography?mode=${option}`}
            aria-current={option === mode ? 'page' : undefined}
          >
            {option}
          </a>
        ))}
      </div>

      <div className="callout">
        <strong>District, not city.</strong> The level between pincode and zone is filled
        from the revenue district on the pincode master, which is the only city-like field
        the data has. A district is much larger than the city sharing its name — Pune is
        149 pincodes including rural Pune, where a negotiation saying &ldquo;Pune&rdquo;
        usually means about a dozen. The coverage count below every endpoint is the number
        to check before saving.
      </div>

      <h3>Add a rule</h3>
      <GeographyRuleEditor
        mode={mode}
        canEdit={canEdit}
        existing={existing}
        onSearch={searchGeographyAction}
        onCoverage={coverageAction}
        onPreview={async (previewMode, origin, destination, rates) => {
          'use server';
          return previewRuleAction(cardKey, previewMode, origin, destination, rates);
        }}
        onSave={async (rule) => {
          'use server';
          await saveLaneRule(cardKey, { id: newRuleId(), ...rule });
        }}
      />

      <h3>Every rule, most specific first</h3>
      <p className="lede">This is the order a quote checks in.</p>
      <RuleCascade
        rules={stored}
        ordered={ordered}
        {...(canEdit
          ? {
              onRemove: async (id: string) => {
                'use server';
                await removeLaneRule(cardKey, id);
              },
            }
          : {})}
      />

      <h3>Test a shipment</h3>
      <p className="lede">
        Check a real pincode pair against the cascade above before it ever reaches a
        customer.
      </p>
      <ShipmentTester
        mode={mode}
        onTest={async (testMode, origin, destination) => {
          'use server';
          return testShipmentAction(cardKey, testMode, origin, destination);
        }}
      />
    </>
  );
}
