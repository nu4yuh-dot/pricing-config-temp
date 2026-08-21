import type { Invoice } from './invoice';
import type { CancelPolicy } from './settlement';

/**
 * Correcting an invoice that is wrong.
 *
 * There are three routes and they are not interchangeable — which one is available depends
 * on how far the document has travelled, and picking the wrong one is a tax problem rather
 * than a tidiness problem.
 *
 *   Edit the draft. Nothing has been issued, no series number is spent, nobody has seen
 *   it. Change it freely.
 *
 *   Credit or debit note. The invoice has been issued. It cannot be altered — it is a
 *   numbered document in a filed series — so the correction is a *second* document that
 *   references it. A credit note reduces what is owed, a debit note increases it.
 *
 *   Cancel. The invoice has been issued but nothing has happened since: not paid, not
 *   part-paid, not yet in a filed return. The number stays spent and is explained.
 *
 * The rule that decides between the last two is simple and unforgiving: **once money has
 * moved against an invoice, it can only be corrected by a note.** Cancelling a paid
 * invoice would leave a payment attached to a document that no longer exists.
 */

export const CORRECTION_ROUTES = ['edit-draft', 'credit-note', 'debit-note', 'cancel'] as const;
export type CorrectionRoute = (typeof CORRECTION_ROUTES)[number];

export const CORRECTION_LABELS: Record<CorrectionRoute, string> = {
  'edit-draft': 'Edit the draft',
  'credit-note': 'Raise a credit note',
  'debit-note': 'Raise a debit note',
  cancel: 'Cancel the invoice',
};

export interface CorrectionContext {
  /** Whether this invoice has been included in a filed GST return. */
  filed: boolean;
  /** The customer's arrangement. Cancelling may need somebody's approval, or be refused. */
  cancelPolicy: CancelPolicy;
  /** Whether the period this invoice belongs to has been locked. */
  periodLocked: boolean;
}

export interface RouteOption {
  route: CorrectionRoute;
  available: boolean;
  /** Why not, in words for the person looking at the screen. */
  reason?: string;
  /** Available, but somebody has to say yes first. */
  needsApproval?: boolean;
}

/**
 * Whether the correction changes the amount up or down decides the note, not the operator.
 *
 * Offering both and letting somebody choose invites a credit note that increases a bill,
 * which is a document that means the opposite of what it says.
 */
export function noteKindFor(deltaPaise: number): 'credit-note' | 'debit-note' | null {
  if (deltaPaise === 0) return null;
  return deltaPaise < 0 ? 'credit-note' : 'debit-note';
}

/** Every route, with whether it can be taken and why not. */
export function correctionRoutes(
  invoice: Invoice,
  context: CorrectionContext,
): RouteOption[] {
  const issued = invoice.status !== 'cancelled';
  const moneyMoved = invoice.paidPaise > 0;
  const alreadyCancelled = invoice.status === 'cancelled';

  return [
    {
      route: 'edit-draft',
      // Nothing here is a draft: an invoice in this system has a number and has been
      // issued. Drafts are corrected before they become invoices at all.
      available: false,
      reason: alreadyCancelled
        ? 'This invoice is cancelled.'
        : 'This invoice has been issued and carries a series number. Issued documents are corrected by a note.',
    },
    creditOrDebit('credit-note', invoice, context),
    creditOrDebit('debit-note', invoice, context),
    cancelRoute(invoice, context, { issued, moneyMoved, alreadyCancelled }),
  ];
}

function creditOrDebit(
  route: 'credit-note' | 'debit-note',
  invoice: Invoice,
  context: CorrectionContext,
): RouteOption {
  if (invoice.status === 'cancelled') {
    return {
      route,
      available: false,
      reason: 'A cancelled invoice has nothing to correct. Raise a fresh invoice instead.',
    };
  }

  if (context.periodLocked) {
    // A note lands in the period it is *raised* in, not the one it corrects, so a locked
    // period is not a reason to refuse one. Said explicitly because it looks like one.
    return {
      route,
      available: true,
      reason: 'The original period is locked; the note will fall in the current one.',
    };
  }

  return { route, available: true };
}

function cancelRoute(
  invoice: Invoice,
  context: CorrectionContext,
  state: { issued: boolean; moneyMoved: boolean; alreadyCancelled: boolean },
): RouteOption {
  if (state.alreadyCancelled) {
    return { route: 'cancel', available: false, reason: 'Already cancelled.' };
  }

  if (state.moneyMoved) {
    // The unforgiving one. A payment attached to a document that no longer exists cannot
    // be reconciled by anybody, in either system.
    return {
      route: 'cancel',
      available: false,
      reason:
        'Money has been received against this invoice. Correct it with a credit note — cancelling would leave the payment attached to nothing.',
    };
  }

  if (context.filed) {
    return {
      route: 'cancel',
      available: false,
      reason:
        'This invoice is in a filed return. It can no longer be cancelled; a credit note is the correction.',
    };
  }

  if (context.cancelPolicy === 'block') {
    return {
      route: 'cancel',
      available: false,
      reason: 'This customer’s arrangement does not permit cancelling an issued invoice.',
    };
  }

  return {
    route: 'cancel',
    available: true,
    ...(context.cancelPolicy === 'requireApproval' ? { needsApproval: true } : {}),
  };
}

/**
 * The route to take for a given correction, or why there is none.
 *
 * Chooses rather than offers, because the amount already decides it: a reduction is a
 * credit note and an increase is a debit note, and cancelling is only for taking a
 * document back whole.
 */
export function routeFor(
  invoice: Invoice,
  context: CorrectionContext,
  intent: { deltaPaise: number; withdrawEntirely: boolean },
): { route: CorrectionRoute; needsApproval: boolean } | { refused: string } {
  const options = correctionRoutes(invoice, context);
  const find = (route: CorrectionRoute) => options.find((option) => option.route === route)!;

  if (intent.withdrawEntirely) {
    const cancel = find('cancel');
    if (cancel.available) return { route: 'cancel', needsApproval: cancel.needsApproval === true };

    // Withdrawing a document that cannot be cancelled is a full-value credit note — the
    // same commercial effect, by the route that is actually open.
    const credit = find('credit-note');
    if (credit.available) return { route: 'credit-note', needsApproval: false };
    return { refused: cancel.reason ?? 'This invoice cannot be corrected.' };
  }

  const kind = noteKindFor(intent.deltaPaise);
  if (!kind) return { refused: 'Nothing to correct — the amount is unchanged.' };

  const option = find(kind);
  if (!option.available) return { refused: option.reason ?? 'That correction is not available.' };
  return { route: kind, needsApproval: false };
}
