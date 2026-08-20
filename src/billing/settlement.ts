
/**
 * Settlement profiles: how a customer pays, how often they are billed, and what happens
 * when they run out of room.
 *
 * Configuration in the same sense a rate template is. A profile is the *structure* of an
 * arrangement — prepaid or credit, which cycle, how much rope, what to do when the rope
 * runs out — and assigning it to a customer is what makes it real. One profile serves
 * fifty accounts on the same terms; an override serves the one that negotiated something
 * different.
 *
 * The rulings this follows:
 *
 *   Wallet and GST   The wallet is what the customer paid in, so it must cover the whole
 *                    bill. Room is checked against the invoice total, not the freight.
 *   Bill cycles      All four, including per-transaction, where every AWB is its own bill
 *                    and there is no period at all.
 *   On breach        The action is itself configuration. A ₹50,000 ecommerce account and a
 *                    ₹40-lakh OEM do not deserve the same treatment for going ₹2,000 over.
 *
 * The cost of that last one is that `allowAndFlag` exists: an account configured that way
 * can run up exposure with nothing stopping it. That is why the flagged state is part of
 * the decision rather than an afterthought — somebody has to be able to list them.
 *
 * Nothing here imports the ledger, so the screens can share these types and labels. What
 * needs a balance to answer lives in `settlement-room.ts`: the ledger reaches `node:crypto`,
 * which cannot be bundled for a browser, and duplicating the option lists in the form to
 * dodge that is how a select ends up offering a cycle the engine does not implement.
 */

export const SETTLEMENT_MODES = ['prepaid', 'credit'] as const;
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];

export const BILLING_CYCLES = ['perTransaction', 'weekly', 'fortnightly', 'monthly'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const BREACH_ACTIONS = ['block', 'blockWithOverride', 'allowAndFlag'] as const;
export type BreachAction = (typeof BREACH_ACTIONS)[number];

export const CANCEL_POLICIES = ['block', 'requireApproval', 'allow'] as const;
export type CancelPolicy = (typeof CANCEL_POLICIES)[number];

export const CYCLE_LABELS: Record<BillingCycle, string> = {
  perTransaction: 'One bill per AWB',
  weekly: 'Weekly',
  fortnightly: 'Fortnightly (1–15, 16–end)',
  monthly: 'Monthly, one consolidated bill',
};

export const BREACH_LABELS: Record<BreachAction, string> = {
  block: 'Block',
  blockWithOverride: 'Block, with a named override',
  allowAndFlag: 'Allow and flag',
};

export const BREACH_EFFECTS: Record<BreachAction, { allows: boolean; overridable: boolean }> = {
  block: { allows: false, overridable: false },
  blockWithOverride: { allows: false, overridable: true },
  allowAndFlag: { allows: true, overridable: false },
};

/** What a prepaid arrangement needs. Amounts in rupees, as a person enters them. */
export interface PrepaidTerms {
  /**
   * How far below zero a booking may take the balance. Zero means the wallet must cover
   * the bill outright.
   */
  negativeAllowance: number;
  /** Warn when the balance after a booking would fall to or below this. Null to not warn. */
  lowBalanceAlertAt: number | null;
  /** The smallest useful top-up, shown when asking for one. Null to not suggest an amount. */
  minRecharge: number | null;
}

/** What a credit arrangement needs. */
export interface CreditFacility {
  /** How negative the balance may get. Zero is not the same as unlimited. */
  limit: number;
  /** Days from invoice to due. */
  periodDays: number;
  /** Days past due before a bill counts as overdue and holds bookings. */
  graceDays: number;
}

export interface SettlementProfile {
  key: string;
  name: string;
  mode: SettlementMode;
  cycle: BillingCycle;
  onBreach: BreachAction;
  /**
   * Whether an invoice that has already been acted on may be cancelled. Defaults to
   * requiring approval rather than allowing it, because the default applies to every
   * profile nobody has thought about yet, and force-cancelling a paid tax invoice is not
   * something to inherit by accident.
   */
  cancelPolicy: CancelPolicy;
  /** Who may release a blocked booking. Only meaningful with `blockWithOverride`. */
  overrideRole?: string;
  prepaid?: PrepaidTerms;
  credit?: CreditFacility;
}

/**
 * A customer's own departures from the profile. Sparse on purpose, exactly as a contract's
 * overrides are: a customer who negotiated a longer period stores that one field and keeps
 * following the profile everywhere else.
 */
export type SettlementOverrides = Partial<
  Pick<SettlementProfile, 'mode' | 'cycle' | 'onBreach' | 'cancelPolicy' | 'overrideRole'>
> & {
  prepaid?: Partial<PrepaidTerms>;
  credit?: Partial<CreditFacility>;
};

export interface EffectiveSettlement {
  mode: SettlementMode;
  cycle: BillingCycle;
  onBreach: BreachAction;
  cancelPolicy: CancelPolicy;
  overrideRole?: string;
  prepaid: PrepaidTerms;
  credit: CreditFacility;
  /** Which profile this came from, and which fields the customer overrode. */
  profileKey: string;
  overridden: string[];
}

export const DEFAULT_PREPAID: PrepaidTerms = {
  negativeAllowance: 0,
  lowBalanceAlertAt: null,
  minRecharge: null,
};

export const DEFAULT_CREDIT: CreditFacility = { limit: 0, periodDays: 30, graceDays: 0 };

/**
 * The arrangement actually in force, and what departed from the profile.
 *
 * Both sub-objects are always present so a caller never has to test which mode it is
 * before reading a field; `mode` decides which one governs.
 */
export function resolveSettlement(
  profile: SettlementProfile,
  overrides: SettlementOverrides = {},
): EffectiveSettlement {
  const overridden: string[] = [];
  const take = <K extends 'mode' | 'cycle' | 'onBreach' | 'cancelPolicy'>(key: K) => {
    const value = overrides[key];
    if (value !== undefined && value !== profile[key]) {
      overridden.push(key);
      return value;
    }
    return profile[key];
  };

  const prepaid = { ...DEFAULT_PREPAID, ...profile.prepaid };
  for (const [key, value] of Object.entries(overrides.prepaid ?? {})) {
    if (value === undefined) continue;
    if (prepaid[key as keyof PrepaidTerms] !== value) overridden.push(`prepaid.${key}`);
    Object.assign(prepaid, { [key]: value });
  }

  const credit = { ...DEFAULT_CREDIT, ...profile.credit };
  for (const [key, value] of Object.entries(overrides.credit ?? {})) {
    if (value === undefined) continue;
    if (credit[key as keyof CreditFacility] !== value) overridden.push(`credit.${key}`);
    Object.assign(credit, { [key]: value });
  }

  const role = overrides.overrideRole ?? profile.overrideRole;
  if (overrides.overrideRole !== undefined && overrides.overrideRole !== profile.overrideRole) {
    overridden.push('overrideRole');
  }

  return {
    mode: take('mode'),
    cycle: take('cycle'),
    onBreach: take('onBreach'),
    cancelPolicy: take('cancelPolicy'),
    ...(role === undefined ? {} : { overrideRole: role }),
    prepaid,
    credit,
    profileKey: profile.key,
    overridden,
  };
}
