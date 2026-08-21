import { afterEach, describe, expect, test } from 'vitest';
import { consume, resetRateLimits, DEFAULT_LIMIT, WINDOW_MS } from './rate-limit';

afterEach(() => {
  resetRateLimits();
  delete process.env.API_RATE_LIMIT;
});

describe('counting a caller against its budget', () => {
  test('the first request is allowed and reports the budget', () => {
    const decision = consume('samex-core', 1_000);
    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBe(DEFAULT_LIMIT);
    expect(decision.remaining).toBe(DEFAULT_LIMIT - 1);
  });

  test('a caller may make exactly its budget, and the next one is refused', () => {
    // Off by one here is the difference between a limit of 600 meaning 600 or 599.
    for (let i = 0; i < DEFAULT_LIMIT; i += 1) {
      expect(consume('samex-core', 1_000).allowed).toBe(true);
    }
    const refused = consume('samex-core', 1_000);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
  });

  test('a refusal says when to come back, and never says zero seconds', () => {
    // Retry-After: 0 invites an immediate retry, which is the opposite of the point.
    for (let i = 0; i <= DEFAULT_LIMIT; i += 1) consume('samex-core', 1_000);
    const refused = consume('samex-core', 1_000 + WINDOW_MS - 10);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  test('the window resets, so a refused caller recovers on its own', () => {
    for (let i = 0; i <= DEFAULT_LIMIT; i += 1) consume('samex-core', 1_000);
    expect(consume('samex-core', 1_000).allowed).toBe(false);
    expect(consume('samex-core', 1_000 + WINDOW_MS).allowed).toBe(true);
  });

  test('callers have separate budgets, so one cannot spend another’s', () => {
    for (let i = 0; i <= DEFAULT_LIMIT; i += 1) consume('noisy', 1_000);
    expect(consume('noisy', 1_000).allowed).toBe(false);
    expect(consume('quiet', 1_000).allowed).toBe(true);
  });
});

describe('the configured limit', () => {
  test('a limit set in the environment is honoured', () => {
    process.env.API_RATE_LIMIT = '2';
    expect(consume('c', 1_000).allowed).toBe(true);
    expect(consume('c', 1_000).allowed).toBe(true);
    expect(consume('c', 1_000).allowed).toBe(false);
  });

  test('a nonsensical limit falls back rather than refusing everything', () => {
    // Zero would mean "no requests at all", which nobody means by setting a limit; an
    // unparseable value must not take the API down at request time either.
    for (const bad of ['0', '-5', 'lots', '']) {
      resetRateLimits();
      process.env.API_RATE_LIMIT = bad;
      expect(consume('c', 1_000)).toMatchObject({ allowed: true, limit: DEFAULT_LIMIT });
    }
  });
});
