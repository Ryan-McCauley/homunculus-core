// Exchange order precision — the arithmetic, with nothing async in it.
//
// Gemini rejects an order whose amount carries more precision than the symbol's
// tick size, or whose price does not sit on the symbol's quote increment. Every
// order this server places is therefore conformed first. That conforming used to
// live inline in two async helpers in server/crypto.ts, wrapped around a network
// fetch for the increment, which meant the arithmetic itself had no test seam and
// went un-exercised while sitting directly under every trade.
//
// It is here instead. crypto.ts keeps the fetch-and-cache halves; this holds the
// part that decides how many of the operator's coins actually leave the account.
//
// TWO RULES, and the difference between them is deliberate:
//
//   AMOUNTS FLOOR.  Never round an amount up. Rounding 0.96 to a whole number
//                   sells 1 — more than is held, or more than the notional the
//                   agent cap was checked against. An order that is a hair small
//                   is a smaller fill; an order that is a hair large is a
//                   rejection at best and an unbudgeted spend at worst.
//   PRICES ROUND.   A price is a level, not a quantity. Nudging it to the nearest
//                   increment is what the exchange itself would do; flooring it
//                   would bias every sell down and every buy down by up to one
//                   increment, which is a systematic cost, not a safety margin.
//
// WHY THE SCALING LOOKS LIKE THIS. The obvious `Math.floor(value * 10 ** d) / 10 ** d`
// is wrong often enough to matter: `1.15 * 100` is 114.99999999999999 in binary
// floating point, so flooring at two places yields 1.14 and quietly gives up a
// tick on every order whose amount lands on one of those values. Scaling through
// the number's own decimal (exponential) form instead moves the point rather than
// multiplying, so 1.15 at two places is exactly 115 and floors back to 1.15.

/**
 * Multiplies by a power of ten by shifting the decimal exponent rather than
 * multiplying, which keeps the result free of the binary rounding error a real
 * multiplication introduces. Also survives magnitudes where a naive
 * `${value}e${power}` template would produce `1e-7e8` and parse as NaN.
 */
function scalePow10(value: number, power: number): number {
  if (!Number.isFinite(value)) return NaN
  const [mantissa, exponent] = value.toExponential().split('e') as [string, string]
  return Number(`${mantissa}e${Number(exponent) + power}`)
}

/**
 * Decimal places implied by an exchange increment: 1e-8 → 8, 0.01 → 2, 1 → 0.
 *
 * Clamped at both ends. The floor at 0 matters: an increment of 10 (coarser than
 * a whole unit) yields -1, and `toFixed(-1)` is a RangeError — a crash on the
 * order path, thrown from arithmetic, for a symbol nobody tested. Coarse
 * increments are conformed to whole units instead, which is safe in the flooring
 * direction and never worse than the exchange's own answer. The ceiling at 100 is
 * toFixed's own documented limit.
 */
export function decimalsForIncrement(increment: number): number {
  if (!Number.isFinite(increment) || increment <= 0) return 8
  return Math.min(100, Math.max(0, Math.round(-Math.log10(increment))))
}

/**
 * Truncates toward zero to `decimals` places and formats at exactly that width.
 *
 * Non-finite and non-positive inputs come back as a zero of the right shape
 * rather than throwing: callers hand this raw balances and computed sizes, and a
 * NaN reaching the exchange as a quantity is worse than a rejected zero.
 */
export function floorToDecimals(value: number, decimals: number): string {
  const d = Math.min(100, Math.max(0, Math.trunc(decimals) || 0))
  if (!Number.isFinite(value) || value <= 0) return (0).toFixed(d)
  const floored = Math.floor(scalePow10(value, d))
  return scalePow10(floored, -d).toFixed(d)
}

/**
 * Rounds half-up to `decimals` places and formats at exactly that width. Used for
 * prices only — see the amounts/prices rule at the top of this file.
 */
export function roundToDecimals(value: number, decimals: number): string {
  const d = Math.min(100, Math.max(0, Math.trunc(decimals) || 0))
  if (!Number.isFinite(value) || value <= 0) return (0).toFixed(d)
  const rounded = Math.round(scalePow10(value, d))
  return scalePow10(rounded, -d).toFixed(d)
}

/** Decimal places a formatted amount actually carries — `"0.9600"` → 4. */
export function decimalsOf(amount: string): number {
  return amount.split('.')[1]?.length ?? 0
}
