import { ENDPOINT_LABEL, type LaneRule } from '../../domain/lane-rules';
import type { RuleRates } from '../../domain/lane-rule-store';

/**
 * Every rule on the card, most specific first.
 *
 * The order is the resolver's own, not a presentation choice — somebody reading this is
 * reading the cascade a quote walks. With one lane shape you could answer "why is this
 * price what it is" by looking at a cell; with six endpoint kinds you cannot, and this is
 * the replacement for that.
 */
export default function RuleCascade({
  rules,
  ordered,
  onRemove,
}: {
  rules: Record<string, { id: string }>;
  /** Already sorted by `orderRules`, so this component never re-decides precedence. */
  ordered: (LaneRule<RuleRates> & { id: string })[];
  onRemove?: (id: string) => Promise<void>;
}) {
  if (ordered.length === 0) {
    return (
      <p className="empty">
        No rules yet. Every lane is priced by the zone grid, which is the case where both
        ends of a rule are zones.
      </p>
    );
  }

  return (
    <ol className="precedence">
      {ordered.map((rule, index) => (
        <li className="precedence-row" key={rule.id}>
          <span className="rank">{index + 1}</span>
          <span className="what">
            <strong>
              {rule.origin.kind === 'any' ? 'Pan-India' : rule.origin.value} →{' '}
              {rule.destination.kind === 'any' ? 'Pan-India' : rule.destination.value}
            </strong>
            <span className="meta">
              {ENDPOINT_LABEL[rule.origin.kind]} → {ENDPOINT_LABEL[rule.destination.kind]} ·{' '}
              {rule.layer}
            </span>
          </span>
          <span className="pill">
            {rule.rates.tier1 === null ? 'not carried' : `₹${rule.rates.tier1}/kg`}
          </span>
          {onRemove && (
            <form
              action={async () => {
                'use server';
                await onRemove(rule.id);
              }}
            >
              <button type="submit" className="btn small">
                Remove
              </button>
            </form>
          )}
        </li>
      ))}
      <li className="precedence-row default">
        <span className="rank">{ordered.length + 1}</span>
        <span className="what">
          <strong>The zone grid</strong>
          <span className="meta">Anything no rule above matches</span>
        </span>
        <span className="pill muted">as configured</span>
      </li>
      {Object.keys(rules).length !== ordered.length && (
        <li className="meta">
          {Object.keys(rules).length - ordered.length} rule(s) belong to another mode and are
          not shown.
        </li>
      )}
    </ol>
  );
}
