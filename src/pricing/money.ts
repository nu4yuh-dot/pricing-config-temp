/**
 * Money, as integers.
 *
 * Every amount in this engine used to be a floating-point number of rupees, corrected
 * after each step with `round2`. That produced right answers as long as every author
 * remembered the correction, which is a poor foundation for a system whose entire job is
 * to agree with a signed contract to the paisa. Here money is an integer count of paise
 * and the correctness is a property of the arithmetic rather than of anybody's diligence.
 *
 * Three rules hold throughout:
 *
 * 1. **Amounts are integer paise.** Addition and subtraction of integers is exact, so no
 *    sum of parts can ever disagree with a total.
 * 2. **Rates are exact fractions, never floats.** A 5% GST is 5/100, not 0.05 — because
 *    0.05 is not representable in binary and `amount * 0.05` is therefore already wrong
 *    before it is rounded.
 * 3. **Rounding happens where the source workbook rounds, and nowhere else.** The
 *    workbooks compute fuel and GST with `ROUND(x, 1)` — to a tenth of a rupee — and the
 *    signed rate cards were agreed on those numbers. `TENTH_RUPEE` expresses that
 *    granularity exactly; the alternative would be an engine that is arithmetically
 *    purer and disagrees with the paperwork by five paise a line.
 *
 * Storage stays in rupees. Cards, contracts and the API are unchanged — conversion
 * happens at the edges of this engine, which is why nothing outside it had to move.
 */

/** An integer count of paise. Branded, so a rupee figure cannot be passed as one. */
export type Paise = number & { readonly __money: 'paise' };

/**
 * A thousandth of a paise: the working scale for rate × weight.
 *
 * A per-kg rate against a fractional weight is not a whole number of paise — ₹23.50 over
 * 53.3 kg is 125,255 paise exactly, but ₹23.50 over 0.55 kg is 1292.5. Carrying the
 * intermediate at a thousandth of a paise keeps every slab product an exact integer, so
 * the one rounding happens after the slabs are summed rather than inside each of them.
 */
export type MilliPaise = number & { readonly __money: 'millipaise' };

/** Rounding granularity, in paise. */
export const PAISE = 1;
/** A tenth of a rupee — the workbooks' `ROUND(x, 1)`, used for fuel and GST. */
export const TENTH_RUPEE = 10;

export const ZERO = 0 as Paise;

/**
 * Anything above this and integer arithmetic stops being exact.
 *
 * Products here are small — a rate in paise times a weight in grams — but a corrupt card
 * carrying a rate of 10^12 would silently produce nonsense rather than an error, and
 * silent nonsense in a money engine is the failure worth spending a branch on.
 */
function checkSafe(value: number, what: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${what} is outside the range integer arithmetic can hold exactly: ${value}`);
  }
}

/**
 * The finest decimal this module will treat as meant.
 *
 * Six is well past anything money or a tariff is written to, and short enough that scaling
 * a realistic amount by it stays inside exact integer range. It also does the job that
 * matters: `0.1 + 0.2` prints as 0.30000000000000004, and the seventeen digits of that are
 * representation noise, not a price. Reading them literally is how a rate of thirty paise
 * became an arithmetic overflow.
 */
const MAX_PLACES = 6;

/**
 * How many decimal places a number is written with, read from its own text.
 *
 * Read from the string rather than computed, because the question being asked is about the
 * decimal the person typed, not about the binary that approximates it.
 */
function decimals(value: number): number {
  const text = String(value);
  if (text.includes('e') || text.includes('E')) {
    // Exponential form: 1e-4. Fall back to parsing the exponent, since there is no
    // fractional part to count.
    const [mantissa, exponent] = text.toLowerCase().split('e');
    const mantissaDecimals = mantissa?.split('.')[1]?.length ?? 0;
    return Math.min(MAX_PLACES, Math.max(0, mantissaDecimals - Number(exponent ?? 0)));
  }
  return Math.min(MAX_PLACES, text.split('.')[1]?.length ?? 0);
}

/** 10^n, as an exact integer. */
function pow10(n: number): number {
  let result = 1;
  for (let i = 0; i < n; i++) result *= 10;
  return result;
}

/**
 * Scale a decimal to an exact integer numerator, with its denominator.
 *
 * `0.05` becomes `{ numerator: 5, denominator: 100 }`. Done by shifting the digits of the
 * printed decimal rather than by multiplying, because multiplying is the thing being
 * avoided: `0.07 * 100` is 7.000000000000001.
 */
export function exactFraction(value: number): { numerator: number; denominator: number } {
  const places = decimals(value);
  const denominator = pow10(places);
  // Rounding the product is safe here and only here: at six places or fewer, `value *
  // 10^places` is within half a unit of its exact value, so rounding recovers what was
  // meant — including when the input arrived as float noise.
  const numerator = Math.round(value * denominator);
  checkSafe(numerator, `the value ${value} scaled to an integer`);
  return { numerator, denominator };
}

/** Divide exactly, rounding half away from zero — the rule Excel's ROUND follows. */
function divideRounded(numerator: number, denominator: number): number {
  checkSafe(numerator, 'an intermediate product');
  if (denominator === 0) throw new Error('cannot divide by zero');
  const negative = numerator < 0 !== denominator < 0;
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  // (2n + d) / 2d floors to the half-away-from-zero quotient without ever touching a
  // fraction, so 113.125 → 113.1 lands the same way the workbook lands it.
  const quotient = Math.floor((2 * n + d) / (2 * d));
  return negative ? -quotient : quotient;
}

/**
 * `a × b ÷ d`, rounded half away from zero, with the product carried in arbitrary
 * precision.
 *
 * The product is where exact integer range runs out long before the answer does: a
 * ₹1.4 million freight held in millionths is 1.4e12, and multiplying it by a fuel rate's
 * numerator of 4,675 overflows a double's exact range even though the result is a
 * perfectly ordinary number. Doing the multiplication in BigInt and coming back to a
 * Number after the division keeps the arithmetic exact without putting a ceiling on the
 * amounts this engine will price.
 */
function mulDivRounded(a: number, b: number, d: number): number {
  if (d === 0) throw new Error('cannot divide by zero');
  const product = BigInt(Math.trunc(a)) * BigInt(Math.trunc(b));
  const divisor = BigInt(Math.trunc(d));
  const negative = product < 0n !== divisor < 0n;
  const n = product < 0n ? -product : product;
  const q = divisor < 0n ? -divisor : divisor;
  const quotient = (2n * n + q) / (2n * q);
  const result = Number(negative ? -quotient : quotient);
  checkSafe(result, 'a scaled amount');
  return result;
}

/* ------------------------------------------------------------------ conversion */

/**
 * Rupees, as stored on a card or a contract, to paise.
 *
 * Exact for the two decimal places money is written in, and for anything finer it rounds
 * to the nearest paisa — there is no smaller unit to hold it in.
 */
export function toPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new Error(`${rupees} is not an amount`);
  const { numerator, denominator } = exactFraction(rupees);
  return mulDivRounded(numerator, 100, denominator) as Paise;
}

/** Paise to rupees. For display and for the API response — never for arithmetic. */
export function toRupees(amount: Paise): number {
  return amount / 100;
}

/** A weight in kg to whole grams, which is as fine as any tariff is quoted. */
export function toGrams(kg: number): number {
  if (!Number.isFinite(kg)) throw new Error(`${kg} is not a weight`);
  const { numerator, denominator } = exactFraction(kg);
  return mulDivRounded(numerator, 1000, denominator);
}

/* ------------------------------------------------------------------ arithmetic */

export function add(...amounts: Paise[]): Paise {
  let total = 0;
  for (const amount of amounts) total += amount;
  checkSafe(total, 'a sum of amounts');
  return total as Paise;
}

export function subtract(from: Paise, amount: Paise): Paise {
  return (from - amount) as Paise;
}

export function max(a: Paise, b: Paise): Paise {
  return Math.max(a, b) as Paise;
}

export function min(a: Paise, b: Paise): Paise {
  return Math.min(a, b) as Paise;
}

/**
 * A per-kg rate against a weight, kept at a thousandth of a paise.
 *
 * Not rounded here on purpose: a cumulative-slab freight is three of these added
 * together, and rounding each one first would round three times where the workbook rounds
 * once.
 */
export function perKg(ratePaise: Paise, weightGrams: number): MilliPaise {
  const product = ratePaise * weightGrams;
  checkSafe(product, 'a rate times a weight');
  return product as MilliPaise;
}

export function addMilli(...amounts: MilliPaise[]): MilliPaise {
  let total = 0;
  for (const amount of amounts) total += amount;
  checkSafe(total, 'a sum of rate-times-weight products');
  return total as MilliPaise;
}

export const ZERO_MILLI = 0 as MilliPaise;

/** Bring a working amount down to paise, rounding half away from zero. */
export function settleMilli(amount: MilliPaise, granularity: number = PAISE): Paise {
  return (divideRounded(amount, 1000 * granularity) * granularity) as Paise;
}

/**
 * A percentage of an amount — fuel, GST, a discount.
 *
 * `rate` is the decimal as stored (0.05 for 5%), converted to an exact fraction before it
 * is used, so the multiplication never happens in binary floating point. `granularity`
 * says what the answer is rounded to: `TENTH_RUPEE` for fuel and GST, because that is
 * what the workbooks and the signed cards agree on.
 */
export function rateOf(amount: Paise, rate: number, granularity: number = PAISE): Paise {
  const { numerator, denominator } = exactFraction(rate);
  const scaled = mulDivRounded(amount, numerator, denominator * granularity);
  return (scaled * granularity) as Paise;
}

/**
 * A percentage written as a number of percent — 10 for 10%, 12.5 for twelve and a half.
 *
 * Separate from `rateOf` because an offer is written in percent and a fuel surcharge is
 * stored as a decimal fraction, and converting one into the other in a caller is where a
 * factor of a hundred goes missing.
 */
export function percentOf(amount: Paise, percent: number, granularity: number = PAISE): Paise {
  const { numerator, denominator } = exactFraction(percent);
  const scaled = mulDivRounded(amount, numerator, denominator * 100 * granularity);
  return (scaled * granularity) as Paise;
}

/** Round an amount already in paise to a coarser granularity. */
export function roundTo(amount: Paise, granularity: number): Paise {
  return (divideRounded(amount, granularity) * granularity) as Paise;
}

/* -------------------------------------------------------------- micro-rupees */

/**
 * A millionth of a rupee.
 *
 * The Bluedart franchise workbook rounds nothing at all — its own GST on a 30 kg surface
 * shipment is ₹177.998058 — and the 127 golden fixtures are what that workbook computes.
 * Rounding that path to the paisa would put this engine a fraction away from the document
 * the business quotes from, so it keeps the workbook's precision while still being
 * integral: six decimal places holds every one of those 127 values exactly.
 *
 * Beyond six places the arithmetic rounds, which the workbook does not. That is a
 * millionth of a rupee, it is deterministic, and it replaces a float accumulation whose
 * result depended on the order the terms were added.
 */
export type Micro = number & { readonly __money: 'micro' };

export const ZERO_MICRO = 0 as Micro;

export function toMicro(rupees: number): Micro {
  if (!Number.isFinite(rupees)) throw new Error(`${rupees} is not an amount`);
  const { numerator, denominator } = exactFraction(rupees);
  return mulDivRounded(numerator, 1_000_000, denominator) as Micro;
}

export function microToRupees(amount: Micro): number {
  return amount / 1_000_000;
}

/** For the ledger, which counts paise. Ten thousand micro-rupees to the paisa. */
export function microToPaise(amount: Micro): Paise {
  return divideRounded(amount, 10_000) as Paise;
}

/** `amount × count ÷ divisor`, for the scaled multiplications the cards need. */

export function addMicro(...amounts: Micro[]): Micro {
  let total = 0;
  for (const amount of amounts) total += amount;
  checkSafe(total, 'a sum of amounts');
  return total as Micro;
}

export function maxMicro(a: Micro, b: Micro): Micro {
  return Math.max(a, b) as Micro;
}

/** A percentage of a micro-rupee amount — fuel, GST, FOV — as an exact fraction. */
export function microRateOf(amount: Micro, rate: number): Micro {
  const { numerator, denominator } = exactFraction(rate);
  return mulDivRounded(amount, numerator, denominator) as Micro;
}

/**
 * A per-kilogram rate against a weight in grams.
 *
 * The division by a thousand is where a fraction can appear, so it rounds explicitly
 * rather than leaving a float behind. For every rate and weight these cards actually
 * carry the division is exact and the rounding never fires; it is here so that a rate
 * quoted to six decimals cannot quietly reintroduce the thing this module removes.
 */
export function microPerKg(rateMicro: Micro, grams: number): Micro {
  return mulDivRounded(rateMicro, grams, 1000) as Micro;
}

/**
 * A rate against a whole count — kilograms in a band, or half-kilo blocks.
 *
 * The count is exact by construction, so the product is too: no rounding happens here at
 * all, which is what lets an incremental slab freight be summed before anything is settled.
 */
export function microTimes(amount: Micro, count: number): Micro {
  const product = amount * count;
  checkSafe(product, 'a rate times a count');
  return product as Micro;
}

/** For the few places that must hand a paise figure to something expecting a count. */
export function asPaise(whole: number): Paise {
  if (!Number.isInteger(whole)) {
    throw new Error(`${whole} is not a whole number of paise`);
  }
  return whole as Paise;
}
