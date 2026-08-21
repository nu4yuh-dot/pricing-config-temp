import { describe, expect, test } from 'vitest';
import { attempt, reasonFrom } from './action-result';

describe('carrying a refusal across the action boundary', () => {
  test('a success carries its value and says so', async () => {
    await expect(attempt('nope', async () => ({ key: 'abc' }))).resolves.toEqual({ ok: true, key: 'abc' });
  });

  test('a refusal returns its own sentence, not a generic one', async () => {
    // The whole point: a production build strips a thrown message, and these sentences were
    // written so somebody would know what to do.
    const outcome = await attempt('Could not schedule the offer', async () => {
      throw new Error('An offer called “Diwali” already exists.');
    });
    expect(outcome).toEqual({ error: 'An offer called “Diwali” already exists.' });
  });

  test('something thrown with no message falls back to what was being attempted', async () => {
    const outcome = await attempt('Could not save the carrier', async () => { throw new Error(''); });
    expect(outcome).toEqual({ error: 'Could not save the carrier' });
  });

  test('a redirect is passed through, not swallowed', async () => {
    // redirect() works by throwing. Catching it would turn a navigation into an error toast
    // and strand the user on the page they had just finished with.
    const redirectError = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/approvals;307;' });
    await expect(attempt('nope', async () => { throw redirectError; })).rejects.toBe(redirectError);
  });

  test('notFound() is passed through for the same reason', async () => {
    const notFound = Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });
    await expect(attempt('nope', async () => { throw notFound; })).rejects.toBe(notFound);
  });
});

describe('reading a reason out of whatever an action returned', () => {
  test('it takes an Error, a string, or a returned { error }', () => {
    expect(reasonFrom(new Error('boom'))).toBe('boom');
    expect(reasonFrom('boom')).toBe('boom');
    expect(reasonFrom({ error: 'boom' })).toBe('boom');
    expect(reasonFrom({ message: 'boom' })).toBe('boom');
  });

  test('nothing usable says so rather than pretending', () => {
    expect(reasonFrom(null)).toMatch(/no reason was given/i);
    expect(reasonFrom({})).toMatch(/no reason was given/i);
  });
});
