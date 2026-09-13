# Task 3 Report: Pot settlement

## RED

Command:

```text
node --test packages/poker-engine/test/pots.test.ts
```

Observed result: exit code 1. Node rejected the test module because
`../src/index.ts` did not export `buildPots`. This is the expected missing-feature
failure before `pots.ts` was created.

## GREEN

Focused command after implementation:

```text
node --test packages/poker-engine/test/pots.test.ts
```

Observed result: all 8 pot-settlement tests passed. The first typecheck then caught
a test-only assertion narrowing issue (`refund` inferred as `never` after asserting
an empty array). Moving the total calculation before that narrowing resolved it
without changing production behavior.

Final verification commands:

```text
npm test
npm run typecheck
git diff --check
```

Observed result: all 26 tests passed with 0 failures, TypeScript exited cleanly,
and `git diff --check` reported no whitespace errors.

## Coverage

- Contribution-level main and side pot construction
- Single-contributor unmatched excess refunds
- Folded chips included in amounts and excluded from eligibility
- Multi-pot ties, award aggregation, seat sorting, and clockwise odd chips
- Zero-contribution settlement and exact chip conservation
- Invalid seats, duplicate seats, unsafe or invalid chip amounts, empty eligibility,
  duplicate eligibility, missing or invalid ranks, and invalid button values
