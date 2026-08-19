/**
 * Four roles: the pricing team configures, an admin or a manager approves, and
 * everyone else reads.
 *
 * Capabilities are listed per role rather than derived from a hierarchy, so that
 * "can a configurator approve?" is answered by reading one line instead of
 * reasoning about inheritance. An admin can edit as well as approve — they run the
 * team — but `applyReview` still refuses to let anyone approve their own request,
 * so that remains a real second pair of eyes.
 *
 * A manager holds the admin's commercial authority — approving rate changes and
 * moving money — but not `manage-users`. Handing out accounts and roles is how
 * someone would grant themselves any of the rest, so it stays with the admin until
 * asked otherwise.
 */

export const ROLES = ['configurator', 'manager', 'admin', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  'view-sheets',
  'run-calculator',
  'edit-draft',
  'submit-for-approval',
  'review-change-request',
  'import-pincodes',
  'manage-users',
  'view-audit-log',
  /**
   * Moving money: recharges, payments, raising invoices. Admin only, and separate from
   * approving a rate change — the two are different kinds of authority and a pricing
   * configurator has no business touching a customer's balance.
   */
  'record-money',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const GRANTS: Record<Role, readonly Capability[]> = {
  viewer: ['view-sheets', 'run-calculator'],
  configurator: [
    'view-sheets',
    'run-calculator',
    'edit-draft',
    'submit-for-approval',
    'import-pincodes',
  ],
  manager: [
    'view-sheets',
    'run-calculator',
    'edit-draft',
    'submit-for-approval',
    'review-change-request',
    'import-pincodes',
    'view-audit-log',
    'record-money',
  ],
  admin: [
    'view-sheets',
    'run-calculator',
    'edit-draft',
    'submit-for-approval',
    'review-change-request',
    'import-pincodes',
    'manage-users',
    'view-audit-log',
    'record-money',
  ],
};

export function can(role: Role, capability: Capability): boolean {
  return GRANTS[role]?.includes(capability) ?? false;
}

export const ROLE_LABELS: Record<Role, string> = {
  configurator: 'Configurator',
  manager: 'Manager',
  admin: 'Admin',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  configurator: 'Edits rates and submits them for approval.',
  manager: 'Approves or rejects submitted changes and records money in and out.',
  admin: 'Approves or rejects submitted changes, manages users, and records money in and out.',
  viewer: 'Reads the rate cards and runs quotes.',
};
