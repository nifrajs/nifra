# @nifrajs/coding-agent

## 3.5.0

### Patch Changes

- 6430334: Add the provider-neutral, content-free review report contract and expose `nifra review` through the CLI, authenticated agent RPC, and Workbench-safe view projections.
- 322786e: Keep the session store loadable on Windows by reading file-open flags from the platform-safe filesystem constants.
- Updated dependencies [6430334]
- Updated dependencies [82c3018]
- Updated dependencies [e95cd7e]
  - @nifrajs/agent-review@3.5.0
  - @nifrajs/jobs@3.5.0
  - @nifrajs/pi@3.5.0
  - @nifrajs/agent@3.5.0
  - @nifrajs/agent-protocol@3.5.0

## 3.4.0

### Patch Changes

- 719d82e: Centralize release-facing evidence and certification seams so generated views, runtime adapters, and
  consumer checks stay aligned.
- Updated dependencies [8d23613]
- Updated dependencies
  - @nifrajs/agent-protocol@3.4.0
  - @nifrajs/agent@3.4.0
  - @nifrajs/pi@3.4.0
  - @nifrajs/jobs@3.4.0

## 3.3.0

### Minor Changes

- 10085ce: Add the native approval protocol flow to `@nifrajs/coding-agent`. Native turns can now emit bounded, ordered approval events and resolve pending approvals through the backend protocol, while retaining compatibility with the existing boolean approval callback.

### Patch Changes

- @nifrajs/agent@3.3.0
- @nifrajs/agent-protocol@3.3.0
- @nifrajs/jobs@3.3.0
- @nifrajs/pi@3.3.0

## 3.2.0

### Minor Changes

- e3e197b: Add the isolated Nifra agent protocol, Pi backend adapter, extensible coding-agent CLI, secure local RPC, workflows, sessions, verification, self-healing extensions, and Workbench integration.

### Patch Changes

- 1a041a9: Add provider-neutral gateway and deployment contracts with deterministic reference adapters and evidence-safe policy checks.
- Updated dependencies [7aee593]
- Updated dependencies [8486ed8]
- Updated dependencies [1a041a9]
- Updated dependencies [3eacb4a]
- Updated dependencies [e3e197b]
- Updated dependencies [893f7b3]
- Updated dependencies [7551709]
  - @nifrajs/agent@3.2.0
  - @nifrajs/agent-protocol@3.2.0
  - @nifrajs/pi@3.2.0
  - @nifrajs/jobs@3.2.0
