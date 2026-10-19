# 澳洲个税小算 · FY2025–26

A small Chinese-first, responsive Australian individual income-tax estimator. The reusable JavaScript model is deterministic and dependency-free; it is a rules model, not a trained language model. Synthetic examples only, no accounts, collection, analytics, external APIs, CDN or downloaded assets.

## Run, test, build

Requires Node 22+ (verified with Node v24.19.0). No npm install is needed.

```sh
cd tax-calculator
npm run build
npm test
# Optional browser acceptance; uses existing Playwright and Chromium in this Cloud runtime:
npm run test:browser
```

Open `index.html` directly in a normal browser for offline use. It embeds the same `src/model.mjs`, `src/ui.js` and `src/style.css` source; build removes only module `export` keywords. There is no second handwritten tax engine. The unit test checks byte-for-byte rebuild equality and evaluates the embedded model. To use the exported model:

```js
import { calculateTax } from './src/model.mjs';
calculateTax({ taxableIncome: '100000', paygWithheld: '25000' });
// totalTaxCents: 2278800; paygDifferenceCents: 221200; balanceKind: 'refund'
```

The UI updates as you type, supports keyboard controls, sample income buttons, expandable rules and print. Invalid inputs hide the previous result until corrected. Inputs are not saved. Official source links require a network only when clicked.

## Scope

FY2025–26 only: adult 18+, full-year Australian tax resident, full tax-free threshold, single, no dependants, not SAPTO eligible, no Medicare exemptions. Input is **annual taxable income after deductions**, in whole AUD dollars; the calculator does not calculate deductions. It excludes MLS, HELP/STSL, SAPTO and other offsets, private-health adjustments, special lump sums, foreign residents, part-year residents and working-holiday residents. All outputs are scoped estimates.

Blank, negative, nonfinite, malformed and fractional taxable-income inputs are rejected, including `100000.0`, scientific notation, currency symbols and thousands separators. Surrounding whitespace and leading zeros are accepted. For a clearly bounded demo both income and optional PAYG are limited to $999,999,999,999. PAYG accepts up to two decimal places; blank means **no balance estimate**, not zero.

`remainingCents` means taxable income minus the model's estimated tax; **it is not actual payroll take-home**. Positive `paygDifferenceCents` indicates an estimated refund difference; negative indicates an amount payable. Other omitted liabilities and offsets may change actual assessment.

## Rules and exact rounding

Gross income tax: $0 through $18,200; 16% above $18,200 to $45,000; $4,288 + 30% above $45,000 to $135,000; $31,288 + 37% above $135,000 to $190,000; $51,638 + 45% above $190,000.

LITO: $700 through $37,500; reduce by 5 cents per dollar through $45,000; above that, $325 reduced by 1.5 cents per dollar, floored at zero. Available LITO is rounded half-up to cents first and then capped at gross income tax. It never offsets Medicare or makes tax negative.

Medicare: $0 through $28,011; 10% of income above $28,011 from $28,012 through $35,013 **inclusive**; 2% of whole income from $35,014. The old $27,222 threshold is not used.

All model calculations use BigInt integer dollars, integer cents and half-cents; outputs are safe integer cents. Gross tax and Medicare land exactly on cents for whole-dollar inputs. Net and combined are added/subtracted as integer cents. Rate display alone is rounded to two decimals. This **application estimator convention is not a verified ATO final-assessment rounding rule**. At income $45,001 the rounded available LITO is $324.99 and combined tax is $4,863.33.

## Independent examples (AUD)

| Taxable income | Gross tax | LITO applied | Medicare | Combined |
|---:|---:|---:|---:|---:|
| 18,201 | 0.16 | 0.16 | 0.00 | 0.00 |
| 29,000 | 1,728.00 | 700.00 | 98.90 | 1,126.90 |
| 35,013 | 2,690.08 | 700.00 | 700.20 | 2,690.28 |
| 35,014 | 2,690.24 | 700.00 | 700.28 | 2,690.52 |
| 45,001 | 4,288.30 | 324.99 | 900.02 | 4,863.33 |
| 100,000 | 20,788.00 | 0.00 | 2,000.00 | 22,788.00 |
| 250,000 | 78,638.00 | 0.00 | 5,000.00 | 83,638.00 |

$100,000 taxable income / $25,000 PAYG gives an estimated **$2,212 refund difference** and $77,212 remaining from taxable income.

## Verification and provenance

See `SOURCES.md` for all seven supplied primary references and which facts they support. Retrieval was attempted 2026-10-19, but the existing proxy denied each destination with CONNECT 403; none is claimed to have been independently opened here. The user's reviewed rules supplied on 2026-10-19 are the rules provenance.

Real Node tests use `node:test` and `node:assert/strict`. Expected fixtures are literals independently supplied by the task or hand-calculated, never generated with the function under test. They cover all 20 supplied fixtures, every income-tax threshold +/-1, rejection, PAYG blank/zero/refund/payable/exact/cents, half-cent ties, and monotonicity/reconciliation for every integer income $0–300,000 plus high values. The test command uses `--test-isolation=none` so this managed runtime exposes individual test receipts rather than only one file-level receipt.

Browser acceptance uses actual Chromium and Playwright, with no installs. The managed browser blocks `file://` navigation; the test loads the **actual built HTML** through a temporary loopback HTTP server, takes the browser context offline, and runs 30 UI assertions. It verifies $100k/PAYG $25k, $29k Medicare/total, invalid-input recovery, keyboard, PAYG cases, print visibility, and zero horizontal overflow at desktop/390px/320px. No external requests or page errors occur. Direct `file://` execution remains unverified in this managed browser; no policy was changed to allow it. Synthetic desktop/mobile screenshots are retained under `verification/screenshots/`, with SHA-256 hashes in the manifest. Print checking covers visibility, not a complete printed-PDF layout audit.

`verification/` retains sanitized raw test output, source retrieval receipts, runtime identity and a source/build SHA-256 manifest. Existing repository files are preserved. Only this feature branch is published; no main write, PR, merge or public website deployment is part of this task.
