import type { BillingPeriod } from './periods';
import { isFrozen } from './periods';

/**
 * A customer disputing a line, and what it means for a period that has been billed.
 *
 * The dispute happens in the core: a customer reviews their bill line by line in the
 * enterprise portal and marks the ones they will not pay, which writes a dispute onto the
 * shipment. That reaches us on the shipment update we already accept.
 *
 * What we did not do was act on it. A disputed shipment inside a period that has been
 * billed is precisely the case that needs a reopening — and waiting for somebody to
 * notice is how a disputed line sits on an ageing report for a month pretending to be a
 * collection problem.
 *
 * This proposes rather than acts. Reopening a billed period is a deliberate decision with
 * a reason attached, and "the customer disputed it" is a good reason but still somebody's
 * call — the amount may be recoverable, or the dispute may be wrong.
 */

export interface DisputedLine {
  awb: string;
  customerCode: string;
  /** When the shipment was booked — which period it belongs to. */
  bookedAt: Date;
  disputeStatus: 'open' | 'investigating' | 'resolved' | 'rejected';
  /** What the customer says is wrong with it, in their words. */
  reason?: string;
  /** How much of the line they dispute, in rupees. Absent means the whole line. */
  amount?: number;
  /** What the line was billed at. */
  billedTotal: number;
}

export interface ReopeningProposal {
  customerCode: string;
  periodFrom: Date;
  lines: DisputedLine[];
  /** Total under dispute, in rupees. */
  disputedAmount: number;
  /** A reason ready to be recorded against the reopening, if somebody accepts it. */
  suggestedReason: string;
}

/** A dispute nobody has settled yet. Resolved and rejected are both settled. */
export function isLive(line: DisputedLine): boolean {
  return line.disputeStatus === 'open' || line.disputeStatus === 'investigating';
}

/**
 * Which billed periods have live disputes in them.
 *
 * Only frozen periods produce a proposal. A dispute against an open period needs no
 * reopening — the bill has not been raised, so the correction happens before anybody sees
 * it, which is the cheap case and needs no ceremony.
 */
export function reopeningProposals(
  lines: readonly DisputedLine[],
  periods: readonly BillingPeriod[],
): ReopeningProposal[] {
  const frozen = periods.filter((period) => isFrozen(period.state));
  const proposals = new Map<string, ReopeningProposal>();

  for (const line of lines) {
    if (!isLive(line)) continue;

    const period = frozen.find(
      (candidate) =>
        candidate.customerCode === line.customerCode &&
        line.bookedAt >= candidate.from &&
        line.bookedAt <= candidate.to,
    );
    if (!period) continue;

    const key = `${period.customerCode}:${period.from.toISOString()}`;
    const existing = proposals.get(key);
    // A disputed line with no stated amount is disputed in full — the customer is
    // rejecting the line, not haggling over part of it.
    const amount = line.amount ?? line.billedTotal;

    if (existing) {
      existing.lines.push(line);
      existing.disputedAmount = Math.round((existing.disputedAmount + amount) * 100) / 100;
    } else {
      proposals.set(key, {
        customerCode: period.customerCode,
        periodFrom: period.from,
        lines: [line],
        disputedAmount: Math.round(amount * 100) / 100,
        suggestedReason: '',
      });
    }
  }

  for (const proposal of proposals.values()) {
    proposal.suggestedReason = suggestedReason(proposal);
  }

  return [...proposals.values()].sort((a, b) => b.disputedAmount - a.disputedAmount);
}

/**
 * The reason that would be recorded, written out.
 *
 * Offered rather than imposed: whoever reopens the period can say something better, and
 * the reason is what somebody reads a year later when the restatement is questioned.
 */
export function suggestedReason(proposal: ReopeningProposal): string {
  const count = proposal.lines.length;
  const stated = proposal.lines
    .map((line) => line.reason)
    .filter((reason): reason is string => Boolean(reason));

  const head = `${count} line${count === 1 ? '' : 's'} disputed by the customer, ₹${proposal.disputedAmount.toLocaleString('en-IN')}`;
  if (stated.length === 0) return `${head}. No reason given.`;

  // One reason reads as a sentence; several read as a list, and repeating an identical
  // reason five times reads as noise.
  const distinct = [...new Set(stated)];
  return `${head}: ${distinct.slice(0, 3).join('; ')}${distinct.length > 3 ? '; …' : ''}`;
}
