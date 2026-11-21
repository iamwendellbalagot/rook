# PLYTH simplicity live smoke check

Date: 2026-11-21. Model: `openai/gpt-6.1-sol`.

## Method and results

Ran the real Rook `reviewGitChanges({ focus: "simplicity", isolatedEvaluation: true })` path on two fresh, disposable Git fixtures. Both runs used the normal two-provider-request limit.

- **Removable pipeline:** The model identified that a fixed three-step label normalization was wrapped in a single-use operation array and `applySteps` helper. It proposed the equivalent direct trim/replace/lowercase expression and explicitly preserved punctuation, operation order, input behavior, and the test. This was a grounded catch. However, Rook correctly labeled the report partial and attribution unknown because the fixture was supplied through explicit selected paths; supporting-context freshness was also unavailable. Usage: 2 requests, 3,690 input / 621 output tokens.
- **Necessary concurrency control:** The fixture exercised in-flight request coalescing, expiry, and retry after rejection. PLYTH returned `invalid_json`, not a review. Usage: 2 requests, 2,306 input / 55 output / 1,920 cache-read tokens. This is **not** a clean no-finding result.
- **Diagnostic only:** Ran generic `runGenericSimplicityReview` on the same control. It completed without a report, also after 2 requests, with 1,600 input / 55 output / 1,280 cache-read tokens. This does not validate the control; it suggests the bounded review path may be exhausting its request allowance before a usable final response.

Exact prompts, source/test fixtures, reports, and metrics are preserved in `2026-11-21.json`. No stopped pilot cell or freeze was touched.

## Disposition

One positive example shows the reviewer can identify this clear single-use abstraction and offer a correctness-preserving simplification. The necessary-complexity control produced no scoreable judgment, so false-positive resistance is unknown. This is a smoke check, not comparative evidence or an effectiveness claim.

**Next useful move:** diagnose why the review's two-request ceiling yielded an invalid/empty report on the control, then make one bounded control attempt with a usable final response. Do not start another broad pilot based on this result.
