import { describe, expect, test } from 'vitest';
import { ObjectId } from 'mongodb';
import { toCorePayload } from './core-payload';
import type { CustomerDoc } from '../data/customers';
import type { CompanyProfile } from '../domain/company';

const emptyTerms = { overrides: {}, scope: {} } as unknown as CustomerDoc['liveTerms'];

const customer = (over: Partial<CustomerDoc> = {}): CustomerDoc =>
  ({
    _id: new ObjectId(),
    code: 'RL-001',
    name: 'Reliance Logistics',
    baseCardKey: 'model-1',
    liveTerms: emptyTerms,
    draftTerms: emptyTerms,
    ...over,
  }) as CustomerDoc;

const profile = (over: Partial<CompanyProfile> = {}): CompanyProfile => ({
  legalName: 'Reliance Logistics Private Limited',
  contacts: [],
  plants: [],
  ...over,
});

describe('what crosses to the core', () => {
  test('the customer code is the key, and it is ours', () => {
    expect(toCorePayload(customer()).customerCode).toBe('RL-001');
  });

  test('a customer with no active flag is active, so existing records keep trading', () => {
    expect(toCorePayload(customer()).active).toBe(true);
    expect(toCorePayload(customer({ active: false })).active).toBe(false);
  });

  test('commercial terms never cross', () => {
    const payload = toCorePayload(
      customer({
        liveTerms: { overrides: { 'rates.surface.NCR.BOM': 9 } } as unknown as CustomerDoc['liveTerms'],
        settlement: { profileKey: 'oem-45' },
      }),
    );
    // The core does not price, so negotiated rates and payment terms are none of its
    // business — and a rate on a screen somebody should not see is how they leak.
    //
    // Asserted as an allow-list of keys rather than by searching the JSON for values: the
    // payload carries a timestamp, so a search for a stray digit would pass or fail
    // depending on the time of day it ran.
    expect(Object.keys(payload).sort()).toEqual([
      'active', 'addresses', 'adminBookingAccess', 'contacts', 'customerCode',
      'departments', 'name', 'plants', 'portalLogins', 'revision', 'updatedAt',
    ]);
  });

  test('an unknown optional field is omitted, never sent as an empty string', () => {
    // A core that stores "" will print it on a tax invoice.
    const payload = toCorePayload(customer({ profile: profile({ gstin: '   ' }) }));
    expect('gstin' in payload).toBe(false);
    expect('tradeName' in payload).toBe(false);
  });

  test('a customer with no profile at all still produces a valid payload', () => {
    const payload = toCorePayload(customer());
    expect(payload.contacts).toEqual([]);
    expect(payload.plants).toEqual([]);
    expect(payload.portalLogins).toEqual([]);
    expect(payload.addresses).toEqual([]);
    expect(payload.departments).toEqual([]);
    // Off unless turned on: a customer who has never seen the switch is not opted in.
    expect(payload.adminBookingAccess).toBe(false);
  });

  test('the admin-booking switch crosses as the customer set it', () => {
    expect(toCorePayload(customer({ adminBookingAccess: true })).adminBookingAccess).toBe(true);
    expect(toCorePayload(customer({ adminBookingAccess: false })).adminBookingAccess).toBe(false);
  });
});

describe('who gets a portal login', () => {
  const contacts = [
    { name: 'Priya', role: 'Logistics Head', email: 'priya@example.com', portalAccess: true },
    { name: 'Anil', role: 'Accounts Payable', email: 'anil@example.com' },
    { name: 'Site desk', role: 'Plant', portalAccess: true },
  ];

  test('only contacts explicitly granted access, and only with an email', () => {
    const payload = toCorePayload(customer({ profile: profile({ contacts }) }));
    expect(payload.portalLogins.map((login) => login.email)).toEqual(['priya@example.com']);
  });

  test('a recorded email is not consent — Anil is listed but has no login', () => {
    const payload = toCorePayload(customer({ profile: profile({ contacts }) }));
    expect(payload.contacts).toHaveLength(3);
    expect(payload.portalLogins).toHaveLength(1);
  });

  test('emails are lower-cased, because a login should not depend on how it was typed', () => {
    const payload = toCorePayload(
      customer({
        profile: profile({
          contacts: [{ name: 'P', role: 'Head', email: '  Priya@Example.COM ', portalAccess: true }],
        }),
      }),
    );
    expect(payload.portalLogins[0]?.email).toBe('priya@example.com');
  });

  test('closing a customer closes the door without deleting the person', () => {
    const payload = toCorePayload(
      customer({ active: false, profile: profile({ contacts }) }),
    );
    expect(payload.portalLogins[0]?.active).toBe(false);
    expect(payload.contacts).toHaveLength(3);
  });
});

describe('the team roster crossing to the core', () => {
  const roster = (over: Partial<CustomerDoc['enterprise']> = {}) =>
    customer({
      enterprise: {
        team: [
          { email: 'boss@example.com', name: 'Boss', role: 'supply_chain_head', status: 'active', addedAt: new Date() },
          { email: 'priya@example.com', name: 'Priya', role: 'booking', status: 'active', addedAt: new Date() },
          { email: 'gone@example.com', name: 'Gone', role: 'tracking', status: 'disabled', addedAt: new Date() },
        ],
        addresses: [],
        departments: [],
        ...over,
      },
    } as Partial<CustomerDoc>);

  test('every member is sent with their role, so the core can enforce it', () => {
    const logins = toCorePayload(roster()).portalLogins;
    expect(logins.map((login) => [login.email, login.role])).toEqual([
      ['boss@example.com', 'supply_chain_head'],
      ['priya@example.com', 'booking'],
      ['gone@example.com', 'tracking'],
    ]);
  });

  test('a disabled member is sent as inactive, not omitted', () => {
    // Omitting them leaves the core with no instruction about somebody it already knows,
    // and no instruction is not the same as revoke.
    const logins = toCorePayload(roster()).portalLogins;
    expect(logins.find((login) => login.email === 'gone@example.com')?.active).toBe(false);
    expect(logins.find((login) => login.email === 'priya@example.com')?.active).toBe(true);
  });

  test('closing the customer closes every door at once', () => {
    const payload = toCorePayload({ ...roster(), active: false } as CustomerDoc);
    expect(payload.portalLogins.every((login) => login.active === false)).toBe(true);
  });

  test('the roster wins over an older flagged contact for the same person', () => {
    const both = {
      ...roster(),
      profile: profile({
        contacts: [{ name: 'Priya Old', role: 'Head', email: 'priya@example.com', portalAccess: true }],
      }),
    } as CustomerDoc;
    const logins = toCorePayload(both).portalLogins;
    const priya = logins.filter((login) => login.email === 'priya@example.com');
    expect(priya).toHaveLength(1);
    expect(priya[0]?.role).toBe('booking');
    expect(priya[0]?.name).toBe('Priya');
  });

  test('a flagged contact who is not on the roster keeps access, at the least role', () => {
    // Nobody who could sign in yesterday should be locked out by the roster arriving.
    const legacy = customer({
      profile: profile({
        contacts: [{ name: 'Anil', role: 'AP', email: 'anil@example.com', portalAccess: true }],
      }),
    });
    const logins = toCorePayload(legacy).portalLogins;
    expect(logins).toEqual([
      { email: 'anil@example.com', name: 'Anil', active: true, role: 'booking' },
    ]);
  });

  test('a password never appears anywhere in the payload', () => {
    const serialised = JSON.stringify(toCorePayload(roster()));
    for (const word of ['password', 'passwordHash', 'secret', 'credential']) {
      expect(serialised.toLowerCase()).not.toContain(word);
    }
  });
});

describe('the address book crossing to the core', () => {
  const withBook = customer({
    enterprise: {
      team: [],
      departments: [{ id: 'd1', name: 'Production', plantCode: 'PLT-01' }],
      addresses: [
        {
          id: 'a1', label: 'Pune Plant', type: 'both', address: 'Hinjawadi, Pune',
          pincode: 411057, gstin: '27AAACR5055K1ZQ', digipin: '38J-7GH-42K',
          phoneCode: '+91', contactPhone: '9876543210', isDefault: true,
        },
      ],
    },
  } as Partial<CustomerDoc>);

  test('the booking form gets what it needs, dialling code joined to the number', () => {
    const [address] = toCorePayload(withBook).addresses;
    expect(address?.label).toBe('Pune Plant');
    expect(address?.contactPhone).toBe('+919876543210');
    expect(address?.pincode).toBe(411057);
    expect(address?.digipin).toBe('38J-7GH-42K');
    expect(address?.defaultPickup).toBe(true);
  });

  test('departments cross with the plant they belong to', () => {
    expect(toCorePayload(withBook).departments).toEqual([
      { id: 'd1', name: 'Production', plantCode: 'PLT-01', active: true },
    ]);
  });

  test('a department with no active flag crosses as active', () => {
    // Records written before the field existed are in use. Sending them as withdrawn would
    // retire cost centres nobody retired, on the far side, silently.
    const [department] = toCorePayload(withBook).departments;
    expect(department?.active).toBe(true);
  });

  test('a withdrawn department crosses as withdrawn', () => {
    // The whole point of deactivating rather than deleting: the core has to learn about it,
    // and it can only learn from this payload.
    const withdrawn = {
      ...withBook,
      enterprise: {
        ...withBook.enterprise!,
        departments: (withBook.enterprise?.departments ?? []).map((entry) => ({
          ...entry,
          active: false,
        })),
      },
    };
    expect(toCorePayload(withdrawn).departments[0]?.active).toBe(false);
  });
});

describe('the revision', () => {
  test('travels with the payload so a late retry cannot overwrite a newer state', () => {
    expect(toCorePayload(customer({ coreRevision: 7 })).revision).toBe(7);
  });

  test('a customer never pushed reports revision 1, not 0', () => {
    expect(toCorePayload(customer()).revision).toBe(1);
  });
});
