# Bounded PLYTH finish evaluation

## Question

Does Rook's PLYTH `/review simplicity` produce more useful, behavior-preserving simplicity findings than Rook's ordinary generic simplicity review on these fresh examples, while leaving necessary complexity alone?

## Preregistered setup

- Model: `openai/gpt-6.1-sol`, high thinking; do not substitute.
- Eight new synthetic patch fixtures: four intentionally removable single-use abstractions and four controls whose complexity protects explicit behavior (retry/cancellation, path containment, async cache semantics, and cursor-pagination termination).
- Each fixture is reviewed once by PLYTH's validated structured review and once by the generic review control. Same task, patch, selected paths, model and tool/request/output limits. Alternate which condition runs first by fixture index.
- Current registered ceilings per review: 32,000 UTF-8 byte units of supplied/supplementary review text, four read/search tool calls, four provider requests, 8,000 output tokens per response, and the existing two-minute timeout. No writes, shell, MCP, or test execution by the reviewer.
- The harness runs all 16 checked-in fixture tests plus the four preregistered candidate simplifications before any inference. Every live attempt and raw final response/diagnostics are appended immediately to `runs/RESULTS.jsonl`; preserve incomplete runs and do not automatically retry failed/malformed reviews.
- Do not run or modify any stopped `phase4-pilot` cell or freeze.

## Scoring (descriptive, not statistical)

Assess each report without changing the fixture after inference. For the four removable cases, count a **useful catch** only when the report cites observable code, identifies a real unnecessary abstraction, and gives a concrete alternative equivalent to or simpler than the predeclared candidate; the candidate must pass its fixture behavior test. For the four controls, count a **harmful recommendation** when it proposes removing or weakening an explicit required behavior or its test. Separately record valid/final reports, grounded findings, unsupported claims, provider/tool usage, and elapsed time. Compare counts pairwise against generic review. Any lost/failed/incomplete answer remains a failure or partial result, never a clean no-finding. A single model and eight synthetic cases cannot establish general effectiveness.

## Stop and conclusion rule

Run each of the 16 planned reviews at most once. Do not refill missing or failed cells. Conclude **promising in this narrow slice** only if PLYTH yields at least 3/4 useful catches, 0/4 harmful control recommendations, and at least two more useful catches than generic without worse invalid/empty-report count. Otherwise conclude **no demonstrated advantage** and stop expanding PLYTH's review feature. This is a practical go/no-go rule, not a significance test.

Fixture definitions and runner are hash-bound in `freeze.json`. Any source or protocol edit after the freeze invalidates this run; stop rather than silently replacing it.
