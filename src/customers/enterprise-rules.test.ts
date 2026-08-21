import { describe, expect, test } from 'vitest';
import {
  withAddress,
  withoutAddress,
  addressIsCoherent,
  departmentIsPlaceable,
  teamChangeIsAllowed,
  withMember,
} from './enterprise-rules';
import type { BookAddress, TeamMember } from '../domain/enterprise';
import type { Plant } from '../domain/company';

const address = (over: Partial<BookAddress> = {}): BookAddress => ({
  id: 'a1',
  label: 'Pune Plant',
  type: 'both',
  address: 'Hinjawadi, Pune, Maharashtra',
  ...over,
});

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  email: 'priya@example.com',
  name: 'Priya',
  role: 'booking',
  status: 'active',
  addedAt: new Date('2026-01-01'),
  ...over,
});

describe('the default pickup', () => {
  test('starring one unstars the rest', () => {
    const book = [address({ id: 'a1', isDefault: true }), address({ id: 'a2' })];
    const after = withAddress(book, address({ id: 'a2', isDefault: true }));
    expect(after.filter((entry) => entry.isDefault).map((entry) => entry.id)).toEqual(['a2']);
  });

  test('the first usable address becomes the default on its own', () => {
    // One address and no star means every booking asks a question with one answer.
    const after = withAddress([], address({ id: 'a1' }));
    expect(after[0]?.isDefault).toBe(true);
  });

  test('a delivery-only first address does not become a pickup default', () => {
    const after = withAddress([], address({ id: 'a1', type: 'delivery' }));
    expect(after[0]?.isDefault).toBeFalsy();
  });

  test('deleting the default moves the star rather than leaving none', () => {
    const book = [address({ id: 'a1', isDefault: true }), address({ id: 'a2' })];
    const after = withoutAddress(book, 'a1');
    expect(after).toHaveLength(1);
    expect(after[0]?.isDefault).toBe(true);
  });

  test('deleting the only address leaves an empty book, not a dangling star', () => {
    expect(withoutAddress([address({ id: 'a1', isDefault: true })], 'a1')).toEqual([]);
  });

  test('deleting a non-default leaves the star where it was', () => {
    const book = [address({ id: 'a1', isDefault: true }), address({ id: 'a2' })];
    expect(withoutAddress(book, 'a2')[0]?.isDefault).toBe(true);
  });

  test('editing an address in place does not duplicate it', () => {
    const book = withAddress([], address({ id: 'a1' }));
    const after = withAddress(book, address({ id: 'a1', label: 'Renamed' }));
    expect(after).toHaveLength(1);
    expect(after[0]?.label).toBe('Renamed');
  });

  test('a delivery-only address cannot be starred as the pickup default', () => {
    expect(addressIsCoherent(address({ type: 'delivery', isDefault: true }))).toMatch(
      /cannot be the default pickup/,
    );
  });

  test('a pincode that is not six digits is refused', () => {
    expect(addressIsCoherent(address({ pincode: 4001 }))).toMatch(/six digits/);
    expect(addressIsCoherent(address({ pincode: 400001 }))).toBeNull();
  });
});

describe('departments belong to a plant', () => {
  const plants = [{ code: 'PLT-01', name: 'Mumbai Plant' } as Plant];

  test('none can be placed before a plant exists — the screen says so, and so does this', () => {
    expect(departmentIsPlaceable({ name: 'Production', plantCode: 'PLT-01' }, [])).toMatch(
      /Add a plant before/,
    );
  });

  test('a department naming a plant that is not there is refused', () => {
    expect(departmentIsPlaceable({ name: 'Production', plantCode: 'NOPE' }, plants)).toMatch(
      /No plant with code/,
    );
  });

  test('a valid one is allowed', () => {
    expect(departmentIsPlaceable({ name: 'Production', plantCode: 'PLT-01' }, plants)).toBeNull();
  });

  test('an unnamed department is refused', () => {
    expect(departmentIsPlaceable({ name: '  ', plantCode: 'PLT-01' }, plants)).toMatch(/needs a name/);
  });
});

describe('who may change the team', () => {
  const team = [
    member({ email: 'owner@example.com', role: 'supply_chain_head' }),
    member({ email: 'priya@example.com', role: 'booking' }),
  ];

  test('only the owner', () => {
    for (const role of ['logistics_head', 'booking', 'tracking'] as const) {
      expect(teamChangeIsAllowed(team, role, { email: 'priya@example.com' })).toMatch(
        /Only the account owner/,
      );
    }
    expect(teamChangeIsAllowed(team, 'supply_chain_head', { email: 'priya@example.com' })).toBeNull();
  });

  test('the last owner cannot be demoted — that would lock everyone out', () => {
    expect(
      teamChangeIsAllowed(team, 'supply_chain_head', { email: 'owner@example.com', role: 'booking' }),
    ).toMatch(/must keep an owner/);
  });

  test('the last owner cannot be disabled either', () => {
    expect(
      teamChangeIsAllowed(team, 'supply_chain_head', { email: 'owner@example.com', status: 'disabled' }),
    ).toMatch(/must keep an owner/);
  });

  test('with a second active owner, the first may step down', () => {
    const two = [...team, member({ email: 'second@example.com', role: 'supply_chain_head' })];
    expect(
      teamChangeIsAllowed(two, 'supply_chain_head', { email: 'owner@example.com', role: 'booking' }),
    ).toBeNull();
  });

  test('a second owner who is not active does not count as cover', () => {
    const inactive = [...team, member({ email: 'second@example.com', role: 'supply_chain_head', status: 'invited' })];
    expect(
      teamChangeIsAllowed(inactive, 'supply_chain_head', { email: 'owner@example.com', role: 'booking' }),
    ).toMatch(/must keep an owner/);
  });
});

describe('the roster', () => {
  test('emails are lower-cased, so one person cannot appear twice', () => {
    const after = withMember([member({ email: 'priya@example.com' })], member({ email: ' PRIYA@Example.com ' }));
    expect(after).toHaveLength(1);
    expect(after[0]?.email).toBe('priya@example.com');
  });

  test('a member never carries a password, because we never receive one', () => {
    // The type has no such field; this asserts nothing sneaks in through a spread.
    expect(Object.keys(withMember([], member())[0]!)).toEqual(
      expect.not.arrayContaining(['password', 'passwordHash', 'secret']),
    );
  });
});
