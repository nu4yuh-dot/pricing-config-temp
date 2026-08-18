import { beforeEach, describe, expect, test } from 'vitest';
import { checkThrottle, recordFailure, recordSuccess, resetThrottle } from './throttle';

const KEY = '203.0.113.7';

beforeEach(() => resetThrottle());

describe('checkThrottle', () => {
  test('allows a first attempt', () => {
    expect(checkThrottle(KEY).allowed).toBe(true);
  });

  test('keeps allowing attempts below the limit', () => {
    for (let i = 0; i < 7; i++) recordFailure(KEY);
    expect(checkThrottle(KEY).allowed).toBe(true);
  });

  test('counts down the attempts remaining', () => {
    recordFailure(KEY);
    recordFailure(KEY);
    expect(checkThrottle(KEY).remaining).toBe(6);
  });
});

describe('recordFailure', () => {
  test('locks out on the eighth failure', () => {
    for (let i = 0; i < 7; i++) expect(recordFailure(KEY).allowed).toBe(true);
    expect(recordFailure(KEY).allowed).toBe(false);
  });

  test('refuses further attempts once locked out', () => {
    for (let i = 0; i < 8; i++) recordFailure(KEY);
    const state = checkThrottle(KEY);
    expect(state.allowed).toBe(false);
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('reports how long to wait', () => {
    for (let i = 0; i < 8; i++) recordFailure(KEY);
    expect(checkThrottle(KEY).retryAfterSeconds).toBe(15 * 60);
  });

  test('tracks each key independently, so one attacker cannot lock everyone out', () => {
    for (let i = 0; i < 8; i++) recordFailure(KEY);
    expect(checkThrottle(KEY).allowed).toBe(false);
    expect(checkThrottle('198.51.100.4').allowed).toBe(true);
  });
});

describe('windows and lockouts expire', () => {
  const start = 1_000_000;

  test('a stale window resets the count rather than sliding forever', () => {
    for (let i = 0; i < 5; i++) recordFailure(KEY, start);
    // Sixteen minutes later the window has passed.
    expect(checkThrottle(KEY, start + 16 * 60 * 1000).remaining).toBe(8);
  });

  test('a lockout ends after its duration', () => {
    for (let i = 0; i < 8; i++) recordFailure(KEY, start);
    expect(checkThrottle(KEY, start + 60 * 1000).allowed).toBe(false);
    expect(checkThrottle(KEY, start + 16 * 60 * 1000).allowed).toBe(true);
  });
});

describe('recordSuccess', () => {
  test('clears the record so a legitimate user is not penalised for typos', () => {
    for (let i = 0; i < 5; i++) recordFailure(KEY);
    recordSuccess(KEY);
    expect(checkThrottle(KEY).remaining).toBe(8);
  });
});
