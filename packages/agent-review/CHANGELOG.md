# @nifrajs/agent-review

## 5.0.0

### Patch Changes

- 42153fb: `parseReviewReport` and `composeReviewReport` refuse, with `derived-field-mismatch`, a check whose `pass` or `fail` status disagrees with whether it references an error finding. A required check marked `fail` with no error finding can no longer compose a passing report.

## 4.0.2

## 4.0.1

## 4.0.0

## 3.5.0

### Patch Changes

- 6430334: Add the provider-neutral, content-free review report contract and expose `nifra review` through the CLI, authenticated agent RPC, and Workbench-safe view projections.
