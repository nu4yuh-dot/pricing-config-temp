import { describe, expect, test } from 'vitest';
import { correctionRoutes, routeFor, noteKindFor, type CorrectionContext } from './corrections';
import type { Invoice } from './invoice';

const invoice = (over: Partial<Invoice> = {}): Invoice =>
  ({
    number: 'DNS/2026-27/000042',
    customerCode: 'MAHLE',
    mode: 'surface',
    periodFrom: new Date('2026-08-01'),
    periodTo: new Date('2026-08-31'),
    raisedAt: new Date('2026-09-01'),
    sac: '9965',
    gstRate: 0.05,
    rcm: false,
    lines: [],
    taxableValuePaise: 238750,
    gstPaise: 11940,
    totalPaise: 250690,
    paidPaise: 0,
    status: 'unpaid',
    ...over,
  }) as Invoice;

const context = (over: Partial<CorrectionContext> = {}): CorrectionContext => ({
  filed: false,
  cancelPolicy: 'allow',
  periodLocked: false,
  ...over,
});

const routeNamed = (inv: Invoice, ctx: CorrectionContext, name: string) =>
  correctionRoutes(inv, ctx).find((option) => option.route === name)!;

describe('which correction the amount decides', () => {
  test('a reduction is a credit note and an increase is a debit note', () => {
    // Offering both and letting somebody choose invites a credit note that increases a
    // bill, which is a document meaning the opposite of what it says.
    expect(noteKindFor(-5000)).toBe('credit-note');
    expect(noteKindFor(5000)).toBe('debit-note');
  });

  test('no change is not a correction', () => {
    expect(noteKindFor(0)).toBeNull();
    expect(routeFor(invoice(), context(), { deltaPaise: 0, withdrawEntirely: false })).toEqual({
      refused: 'Nothing to correct — the amount is unchanged.',
    });
  });
});

describe('once money has moved, only a note will do', () => {
  test('a part-paid invoice cannot be cancelled', () => {
    // A payment attached to a document that no longer exists cannot be reconciled by
    // anybody, in either system.
    const paid = invoice({ paidPaise: 100000, status: 'part-paid' });
    const cancel = routeNamed(paid, context(), 'cancel');
    expect(cancel.available).toBe(false);
    expect(cancel.reason).toMatch(/credit note/);
  });

  test('but it can still be credited', () => {
    const paid = invoice({ paidPaise: 100000, status: 'part-paid' });
    expect(routeNamed(paid, context(), 'credit-note').available).toBe(true);
  });

  test('withdrawing a paid invoice becomes a full credit note, not a refusal', () => {
    // Same commercial effect, by the route that is actually open.
    const paid = invoice({ paidPaise: 250690, status: 'paid' });
    expect(routeFor(paid, context(), { deltaPaise: -250690, withdrawEntirely: true })).toEqual({
      route: 'credit-note',
      needsApproval: false,
    });
  });
});

describe('a filed return closes the cancel route', () => {
  test('cancel is refused once the invoice is in a filed return', () => {
    const filed = routeNamed(invoice(), context({ filed: true }), 'cancel');
    expect(filed.available).toBe(false);
    expect(filed.reason).toMatch(/filed return/);
  });

  test('a note is still available, because that is the correction after filing', () => {
    expect(routeNamed(invoice(), context({ filed: true }), 'credit-note').available).toBe(true);
  });
});

describe('the customer’s own cancellation policy', () => {
  test('block refuses outright', () => {
    const blocked = routeNamed(invoice(), context({ cancelPolicy: 'block' }), 'cancel');
    expect(blocked.available).toBe(false);
    expect(blocked.reason).toMatch(/does not permit/);
  });

  test('requireApproval allows it but says somebody must agree', () => {
    const option = routeNamed(invoice(), context({ cancelPolicy: 'requireApproval' }), 'cancel');
    expect(option.available).toBe(true);
    expect(option.needsApproval).toBe(true);
  });

  test('allow needs nobody', () => {
    const option = routeNamed(invoice(), context({ cancelPolicy: 'allow' }), 'cancel');
    expect(option.available).toBe(true);
    expect(option.needsApproval).toBeUndefined();
  });
});

describe('a locked period does not block a note', () => {
  test('the note falls in the current period, not the one it corrects', () => {
    // It looks like a reason to refuse, so it is said out loud instead.
    const option = routeNamed(invoice(), context({ periodLocked: true }), 'credit-note');
    expect(option.available).toBe(true);
    expect(option.reason).toMatch(/will fall in the current one/);
  });
});

describe('an issued invoice is never edited in place', () => {
  test('editing is unavailable, and says why', () => {
    // It carries a series number. Altering it would change a numbered document after issue.
    const edit = routeNamed(invoice(), context(), 'edit-draft');
    expect(edit.available).toBe(false);
    expect(edit.reason).toMatch(/series number/);
  });
});

describe('a cancelled invoice', () => {
  test('cannot be cancelled again, nor corrected by a note', () => {
    const cancelled = invoice({ status: 'cancelled' });
    expect(routeNamed(cancelled, context(), 'cancel').reason).toBe('Already cancelled.');
    expect(routeNamed(cancelled, context(), 'credit-note').reason).toMatch(/fresh invoice/);
  });

  test('and refuses a correction with the reason, rather than silently doing nothing', () => {
    const result = routeFor(invoice({ status: 'cancelled' }), context(), {
      deltaPaise: -1000,
      withdrawEntirely: false,
    });
    expect(result).toHaveProperty('refused');
  });
});
