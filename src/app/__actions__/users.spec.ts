import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signInAs, db, cleanup, closeDb, MARK, form, expectOk, reasonFrom } from './harness';
import { headerHolder, RedirectError } from './next-stubs';
import { addUser, changeUserRole, toggleUserActive, changeName, changePassword, signIn } from '../actions';

/**
 * Accounts and roles — the gate every other action is measured against.
 *
 * `manage-users` is deliberately admin-only and **not** held by a manager, who otherwise has
 * the admin's full commercial authority. Handing out accounts and roles is how somebody
 * would grant themselves any of the rest, so it stays separate; that separation is asserted
 * here rather than assumed, because it is the one capability whose absence cannot be
 * compensated for elsewhere.
 *
 * A password is never asserted by reading it back. The stored value is a bcrypt hash, so a
 * test that compared strings would be checking the wrong thing — the assertion is that the
 * new password *signs in* and the old one no longer does.
 */

const EMAIL = `${MARK.toLowerCase()}.user.probe@dnslogistic.com`;
const PASSWORD = 'a-long-enough-password-1';

async function userDoc(email = EMAIL): Promise<Record<string, unknown> | null> {
  return (await db()).collection('users').findOne({ email }) as never;
}

describe('accounts and roles', () => {
  beforeAll(async () => {
    await cleanup();
    await (await db()).collection('users').deleteMany({ email: new RegExp(MARK, 'i') });
    await signInAs('admin', 'admin');
  });

  afterAll(async () => {
    await (await db()).collection('users').deleteMany({ email: new RegExp(MARK, 'i') });
    await cleanup();
    await closeDb();
  });

  test('an admin can add a user', async () => {
    expectOk(
      await addUser(
        null,
        form({ email: EMAIL, name: `${MARK} New Person`, password: PASSWORD, role: 'configurator' }),
      ),
      'adding the user',
    );

    const stored = (await userDoc()) as unknown as {
      name: string;
      role: string;
      passwordHash?: string;
      password?: string;
    } | null;
    expect(stored, 'the user is in the collection').not.toBeNull();
    expect(stored?.role).toBe('configurator');
    // The password must not be recoverable from the record.
    expect(stored?.password, 'a plaintext password must never be stored').toBeUndefined();
    expect(
      stored?.passwordHash?.startsWith('$2'),
      'it is stored as a bcrypt hash',
    ).toBe(true);
  });

  test('name and email are both required', async () => {
    expect(reasonFrom(await addUser(null, form({ email: '', name: 'x', password: PASSWORD }))))
      .toMatch(/email/i);
    expect(reasonFrom(await addUser(null, form({ email: 'a@b.test', name: '', password: PASSWORD }))))
      .toMatch(/name/i);
  });

  /**
   * A taken email is reported, not thrown.
   *
   * The duplicate-key error from the unique index was reaching the caller unhandled, so in a
   * production build — where Next strips a thrown message — an admin adding somebody who
   * already has an account saw boilerplate for the most ordinary mistake on the screen.
   */
  test('the same email twice is refused rather than creating a second account', async () => {
    const outcome = await addUser(
      null,
      form({ email: EMAIL, name: 'Duplicate', password: PASSWORD, role: 'viewer' }),
    );
    expect(reasonFrom(outcome), 'and the reason names the email').toMatch(/already has an account/i);
    expect(
      await (await db()).collection('users').countDocuments({ email: EMAIL }),
      'still one account',
    ).toBe(1);
  });

  test('the new user can sign in with the password they were given', async () => {
    // A distinct client address per attempt, so the sign-in throttle counts these
    // separately rather than one test failing because of the one before it.
    headerHolder.values = { 'x-forwarded-for': '203.0.113.10' };

    // A successful sign-in navigates, so the redirect is the success signal — and the
    // destination is worth asserting too: it proves the session was established, since an
    // unauthenticated caller would be sent back to /login instead.
    let landedOn = '';
    try {
      const outcome = await signIn(null, form({ email: EMAIL, password: PASSWORD }));
      throw new Error(
        `sign-in did not navigate: ${reasonFrom((outcome ?? {}) as { error?: string }) || JSON.stringify(outcome)}`,
      );
    } catch (error) {
      if (!(error instanceof RedirectError)) throw error;
      landedOn = error.url;
    }
    expect(landedOn, 'the credentials just created must work').not.toMatch(/\/login/);
    expect(landedOn).toMatch(/^\//);
  });

  test('a wrong password is refused', async () => {
    headerHolder.values = { 'x-forwarded-for': '203.0.113.11' };
    const outcome = await signIn(null, form({ email: EMAIL, password: 'not-the-password' }));
    expect(reasonFrom((outcome ?? {}) as { error?: string })).not.toBe('');
  });

  test('a role can be changed', async () => {
    const id = String((await userDoc())?._id);
    await changeUserRole(id, 'manager');
    expect(((await userDoc()) as unknown as { role: string }).role).toBe('manager');
  });

  test('an account can be deactivated and reactivated', async () => {
    const id = String((await userDoc())?._id);
    await toggleUserActive(id, false);
    expect(((await userDoc()) as unknown as { active: boolean }).active).toBe(false);
    await toggleUserActive(id, true);
    expect(((await userDoc()) as unknown as { active: boolean }).active).toBe(true);
  });

  /**
   * A manager holds the commercial authority and still cannot hand out accounts.
   *
   * This is the separation that matters most: `record-money` and `review-change-request` are
   * both a manager's, so the only thing standing between them and unlimited authority is
   * this one capability.
   */
  test('a manager cannot add a user or change a role', async () => {
    const id = String((await userDoc())?._id);
    await signInAs('admin2', 'manager');

    for (const attempt of [
      () => addUser(null, form({ email: `${MARK}.sneak@x.test`, name: 'Sneak', password: PASSWORD })),
      () => changeUserRole(id, 'admin'),
      () => toggleUserActive(id, false),
    ]) {
      let refused = false;
      try {
        refused = Boolean(reasonFrom((await attempt()) as { error?: string } ?? {}));
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    }

    expect(
      ((await userDoc()) as unknown as { role: string }).role,
      'the role is unchanged',
    ).toBe('manager');
    expect(
      await (await db()).collection('users').countDocuments({ email: `${MARK}.sneak@x.test` }),
      'and no account was created',
    ).toBe(0);

    await signInAs('admin', 'admin');
  });

  test('a viewer cannot either', async () => {
    await signInAs('viewer', 'viewer');
    let refused = false;
    try {
      refused = Boolean(
        reasonFrom(
          ((await addUser(
            null,
            form({ email: `${MARK}.viewer@x.test`, name: 'V', password: PASSWORD }),
          )) ?? {}) as { error?: string },
        ),
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    await signInAs('admin', 'admin');
  });
});

describe('a person changing their own details', () => {
  beforeAll(async () => {
    await signInAs('admin', 'admin');
  });

  afterAll(async () => {
    await closeDb();
  });

  test('a name shorter than two characters is refused', async () => {
    expect(reasonFrom(((await changeName(null, form({ name: 'x' }))) ?? {}) as { error?: string }))
      .toMatch(/two characters/i);
  });

  test('an over-long name is refused', async () => {
    const outcome = await changeName(null, form({ name: 'y'.repeat(81) }));
    expect(reasonFrom((outcome ?? {}) as { error?: string })).toMatch(/too long/i);
  });

  test('a short new password is refused', async () => {
    const outcome = await changePassword(
      null,
      form({ current: PASSWORD, next: 'short', confirm: 'short' }),
    );
    expect(reasonFrom((outcome ?? {}) as { error?: string })).toMatch(/12/);
  });

  test('a mismatched confirmation is refused', async () => {
    const outcome = await changePassword(
      null,
      form({
        current: PASSWORD,
        next: 'a-long-enough-password-2',
        confirm: 'a-long-enough-password-3',
      }),
    );
    expect(reasonFrom((outcome ?? {}) as { error?: string })).not.toBe('');
  });
});
