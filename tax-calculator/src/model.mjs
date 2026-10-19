/** FY2025–26 scoped resident estimator. All money outputs are integer cents.
 * LITO half-cent ties round up BEFORE capping. This is a demo convention,
 * not a claim about ATO final-assessment rounding. No binary tie arithmetic.
 */
export const MAX_INCOME = 999999999999;
export class InputError extends Error {
  constructor(field, message) { super(message); this.name = 'InputError'; this.field = field; }
}
export function parseIncome(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value).trim()))
    throw new InputError('income', '请输入非负的全年应税收入（澳元整数，不含小数、逗号或科学计数法）。');
  const n = BigInt(String(value).trim());
  if (n > BigInt(MAX_INCOME)) throw new InputError('income', '金额超出本演示范围：最高 $999,999,999,999。');
  return n;
}
export function parsePayg(value = '') {
  if (typeof value === 'string' && value.trim() === '') return null;
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value).trim()))
    throw new InputError('payg', 'PAYG 请输入非负澳元金额，最多两位小数；也可留空。');
  const [d, c = ''] = String(value).trim().split('.');
  const n = BigInt(d) * 100n + BigInt(c.padEnd(2, '0'));
  if (n > BigInt(MAX_INCOME) * 100n) throw new InputError('payg', 'PAYG 金额超出本演示范围。');
  return n;
}
export function calculateTax({taxableIncome, paygWithheld = ''} = {}) {
  const x = parseIncome(taxableIncome), payg = parsePayg(paygWithheld);
  const gross = x <= 18200n ? 0n : x <= 45000n ? (x - 18200n) * 16n
    : x <= 135000n ? 428800n + (x - 45000n) * 30n
    : x <= 190000n ? 3128800n + (x - 135000n) * 37n
    : 5163800n + (x - 190000n) * 45n;
  // Entitlement in HALF cents: above $45k, each dollar removes 1.5 cents.
  const half = x <= 37500n ? 140000n : x <= 45000n ? 140000n - (x - 37500n) * 10n
    : 65000n - (x - 45000n) * 3n;
  const available = half <= 0n ? 0n : (half + 1n) / 2n;
  const lito = available < gross ? available : gross;
  const net = gross - lito;
  const medicare = x <= 28011n ? 0n : x <= 35013n ? (x - 28011n) * 10n : x * 2n;
  const total = net + medicare;
  const difference = payg === null ? null : payg - total;
  return Object.freeze({taxableIncome: Number(x), grossTaxCents: Number(gross),
    litoAvailableCents: Number(available), litoAppliedCents: Number(lito),
    incomeTaxCents: Number(net), medicareCents: Number(medicare), totalTaxCents: Number(total),
    effectiveRatePercent: x === 0n ? 0 : Number(total) / Number(x),
    remainingCents: Number(x * 100n - total), paygCents: payg === null ? null : Number(payg),
    paygDifferenceCents: difference === null ? null : Number(difference),
    balanceKind: difference === null ? null : difference > 0n ? 'refund' : difference < 0n ? 'payable' : 'exact'});
}
