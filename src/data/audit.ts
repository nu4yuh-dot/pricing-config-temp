import { db, COLLECTIONS } from './mongo';
import type { Actor } from './workflow';

/**
 * Append-only record of everything that moved a price or a permission. Never
 * updated or deleted, so the trail stays trustworthy.
 */
export interface AuditEntry {
  action:
    | 'submitted'
    | 'approved'
    | 'rejected'
    | 'partially-approved'
    | 'draft-reset'
    | 'pincodes-imported'
    | 'user-created'
    | 'user-role-changed'
    | 'signed-in'
    | 'password-changed'
    | 'name-changed'
    | 'settlement-profile-created'
    | 'settlement-assigned'
    | 'customer-profile-proposed'
    | 'customer-profile-approved'
    | 'customer-profile-rejected'
    | 'contract-request-raised'
    | 'contract-request-accepted'
    | 'contract-request-declined'
    | 'enterprise-address-saved'
    | 'enterprise-address-deleted'
    | 'enterprise-plant-saved'
    | 'enterprise-plant-deleted'
    | 'enterprise-department-saved'
    | 'enterprise-department-deleted'
    | 'enterprise-team-changed'
    | 'enterprise-billing-change-requested'
    | 'enterprise-config-changed'
    | 'carrier-saved'
    | 'service-saved'
    | 'invoice-series-reconciled'
    | 'receipt-recorded'
    | 'receipt-reallocated'
    | 'receipt-finalised'
    | 'period-billed'
    | 'period-reopened'
    | 'period-relocked'
    | 'bill-line-accepted'
    | 'bill-line-disputed'
    | 'customer-registered'
    | 'contract-proposed'
    | 'contract-draft-reset'
    | 'contract-scope-widened'
    | 'booking-exception-requested'
    | 'booking-exception-approved'
    | 'booking-exception-rejected'
    | 'template-created'
    | 'template-applied'
    | 'template-deleted'
    | 'product-created'
    | 'product-applied'
    | 'customer-tagged'
    | 'contract-prices-locked'
    | 'offer-scheduled'
    | 'customer-profile-updated'
    | 'customer-csv-imported'
    | 'ledger-entry'
    | 'ledger-reversal'
    | 'invoices-raised'
    | 'payment-recorded';
  actor: Actor;
  at: Date;
  rateCardKey?: string;
  detail?: Record<string, unknown>;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  await (await db()).collection<AuditEntry>(COLLECTIONS.auditLog).insertOne(entry);
}

export async function recentAudit(limit = 100): Promise<AuditEntry[]> {
  return (await db())
    .collection<AuditEntry>(COLLECTIONS.auditLog)
    .find()
    .sort({ at: -1 })
    .limit(limit)
    .toArray();
}
