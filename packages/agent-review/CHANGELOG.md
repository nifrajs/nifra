# @nifrajs/agent-review

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.

## 5.0.0

### Patch Changes

- 42153fb: `parseReviewReport` and `composeReviewReport` refuse, with `derived-field-mismatch`, a check whose `pass` or `fail` status disagrees with whether it references an error finding. A required check marked `fail` with no error finding can no longer compose a passing report.

## 4.0.2

## 4.0.1

## 4.0.0

## 3.5.0

### Patch Changes

- 6430334: Add the provider-neutral, content-free review report contract and expose `nifra review` through the CLI, authenticated agent RPC, and Workbench-safe view projections.
