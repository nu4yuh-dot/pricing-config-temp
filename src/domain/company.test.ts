import { describe, expect, test } from 'vitest';
import { checkGstin, checkPan, checkMsme, crossCheckIdentifiers } from './company';

describe('checkGstin', () => {
  test('accepts a well-formed GSTIN', () => {
    const result = checkGstin('27ABCDE1234F1Z5');
    expect(result.valid).toBe(true);
  });

  test('reads the state out of it', () => {
    const result = checkGstin('27ABCDE1234F1Z5');
    expect(result.stateCode).toBe('27');
    expect(result.stateName).toBe('Maharashtra');
  });

  test('reads the embedded PAN out of it', () => {
    expect(checkGstin('27ABCDE1234F1Z5').pan).toBe('ABCDE1234F');
  });

  test('accepts lower case and surrounding space', () => {
    expect(checkGstin('  27abcde1234f1z5  ').valid).toBe(true);
  });

  test('rejects the wrong length, saying what length it got', () => {
    const result = checkGstin('27ABCDE1234F1Z');
    expect(result.valid).toBe(false);
    expect(result.problem).toMatch(/15 characters; this is 14/);
  });

  test('rejects a malformed body', () => {
    // Digits where the PAN letters belong.
    expect(checkGstin('271BCDE1234F1Z5').valid).toBe(false);
  });

  test('rejects a GSTIN without the fixed Z', () => {
    expect(checkGstin('27ABCDE1234F1X5').valid).toBe(false);
  });

  test('rejects an unknown state code', () => {
    const result = checkGstin('99ABCDE1234F1Z5');
    expect(result.valid).toBe(false);
    expect(result.problem).toMatch(/not a GST state code/);
  });

  test('rejects an empty value plainly', () => {
    expect(checkGstin('   ').problem).toMatch(/no gstin/i);
  });

  test('recognises a Delhi registration', () => {
    expect(checkGstin('07ABCDE1234F1Z5').stateName).toBe('Delhi');
  });
});

describe('checkPan', () => {
  test('accepts a well-formed PAN', () => {
    expect(checkPan('ABCDE1234F').valid).toBe(true);
  });

  test('rejects a transposed PAN', () => {
    expect(checkPan('ABCD1E234F').valid).toBe(false);
  });

  test('explains the expected shape', () => {
    expect(checkPan('NOPE').problem).toMatch(/five letters, four digits/);
  });
});

describe('checkMsme', () => {
  test('accepts a Udyam number', () => {
    expect(checkMsme('UDYAM-MH-26-0123456').valid).toBe(true);
  });

  test('rejects anything else', () => {
    expect(checkMsme('MSME12345').valid).toBe(false);
  });
});

describe('crossCheckIdentifiers', () => {
  test('is quiet when everything agrees', () => {
    const problems = crossCheckIdentifiers({
      gstin: '27ABCDE1234F1Z5',
      pan: 'ABCDE1234F',
      stateName: 'Maharashtra',
    });
    expect(problems).toEqual([]);
  });

  test('catches a PAN that disagrees with the one inside the GSTIN', () => {
    const problems = crossCheckIdentifiers({
      gstin: '27ABCDE1234F1Z5',
      pan: 'ZZZZZ9999Z',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/GSTIN contains PAN ABCDE1234F/);
  });

  test('catches an address state that disagrees with the GSTIN registration', () => {
    const problems = crossCheckIdentifiers({
      gstin: '27ABCDE1234F1Z5',
      stateName: 'Karnataka',
    });
    expect(problems[0]).toMatch(/registered in Maharashtra, but the address says Karnataka/);
  });

  test('is case-insensitive about the state', () => {
    expect(
      crossCheckIdentifiers({ gstin: '27ABCDE1234F1Z5', stateName: 'maharashtra' }),
    ).toEqual([]);
  });

  test('reports a malformed GSTIN and stops there', () => {
    const problems = crossCheckIdentifiers({ gstin: 'RUBBISH', pan: 'ABCDE1234F' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/15 characters/);
  });

  test('has nothing to say without a GSTIN', () => {
    expect(crossCheckIdentifiers({ pan: 'ABCDE1234F' })).toEqual([]);
  });
});
