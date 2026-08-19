import { describe, expect, test } from 'vitest';
import { can, ROLES, type Role } from './roles';

describe('permissions', () => {
  test('a configurator may edit a draft and submit it', () => {
    expect(can('configurator', 'edit-draft')).toBe(true);
    expect(can('configurator', 'submit-for-approval')).toBe(true);
  });

  test('a configurator may not approve', () => {
    expect(can('configurator', 'review-change-request')).toBe(false);
  });

  test('an admin may approve', () => {
    expect(can('admin', 'review-change-request')).toBe(true);
  });

  test('an admin may also edit, since they run the pricing team', () => {
    expect(can('admin', 'edit-draft')).toBe(true);
  });

  test('an admin may manage users', () => {
    expect(can('admin', 'manage-users')).toBe(true);
    expect(can('configurator', 'manage-users')).toBe(false);
  });

  test('a viewer may only read and quote', () => {
    expect(can('viewer', 'view-sheets')).toBe(true);
    expect(can('viewer', 'run-calculator')).toBe(true);
    expect(can('viewer', 'edit-draft')).toBe(false);
    expect(can('viewer', 'submit-for-approval')).toBe(false);
    expect(can('viewer', 'review-change-request')).toBe(false);
  });

  test('every role can view sheets and run the calculator', () => {
    for (const role of ROLES) {
      expect(can(role as Role, 'view-sheets')).toBe(true);
      expect(can(role as Role, 'run-calculator')).toBe(true);
    }
  });

  test('a manager may approve, like an admin', () => {
    expect(can('manager', 'review-change-request')).toBe(true);
    expect(can('manager', 'edit-draft')).toBe(true);
    expect(can('manager', 'record-money')).toBe(true);
    expect(can('manager', 'view-audit-log')).toBe(true);
  });

  test('a manager may not manage users — that stays with the admin', () => {
    expect(can('manager', 'manage-users')).toBe(false);
  });

  test('an unknown capability is denied rather than allowed', () => {
    // @ts-expect-error deliberately probing an unlisted capability
    expect(can('admin', 'delete-everything')).toBe(false);
  });
});
