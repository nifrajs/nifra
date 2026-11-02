# @nifrajs/workbench

## 5.11.0

### Patch Changes

- @nifrajs/coding-agent@5.11.0
  - @nifrajs/agent-app@5.11.0
  - @nifrajs/agent-protocol@5.11.0

## 5.10.0

### Patch Changes

- @nifrajs/coding-agent@5.10.0
  - @nifrajs/agent-app@5.10.0
  - @nifrajs/agent-protocol@5.10.0

## 5.9.0

### Patch Changes

- Updated dependencies [93e7078]
- Updated dependencies [123409c]
- Updated dependencies [68d9f31]
- Updated dependencies [975a0f2]
- Updated dependencies [8da7dab]
- Updated dependencies [d6e6617]
- Updated dependencies [5bc60b7]
  - @nifrajs/coding-agent@5.9.0
  - @nifrajs/agent-app@5.9.0
  - @nifrajs/agent-protocol@5.9.0

## 5.8.0

### Patch Changes

- @nifrajs/coding-agent@5.8.0
  - @nifrajs/agent-app@5.8.0
  - @nifrajs/agent-protocol@5.8.0

## 5.7.0

### Patch Changes

- @nifrajs/coding-agent@5.7.0
  - @nifrajs/agent-app@5.7.0
  - @nifrajs/agent-protocol@5.7.0

## 5.6.0

### Patch Changes

- Updated dependencies [2248445]
- Updated dependencies [dfb59d1]
- Updated dependencies [8e63b16]
- Updated dependencies [5950141]
- Updated dependencies [9d131d3]
- Updated dependencies [668becc]
  - @nifrajs/agent-protocol@5.6.0
  - @nifrajs/coding-agent@5.6.0
  - @nifrajs/agent-app@5.6.0

## 5.5.1

### Patch Changes

- @nifrajs/coding-agent@5.5.1
  - @nifrajs/agent-app@5.5.1
  - @nifrajs/agent-protocol@5.5.1

## 5.5.0

### Patch Changes

- 806a7af: Workbench loads a project's `.nifra/extensions/**` only when it is started with `--extensions`, matching `nifra-agent`. Without the flag a Pi-backed session runs no project extension code; pass it only for a repository you trust, since an extension's top-level code runs as soon as it is imported.
- Updated dependencies [50d7389]
- Updated dependencies [69308da]
- Updated dependencies [6fe9b8a]
- Updated dependencies [945f634]
- Updated dependencies [16d085d]
  - @nifrajs/agent-app@5.5.0
  - @nifrajs/coding-agent@5.5.0
  - @nifrajs/agent-protocol@5.5.0

## 5.4.0

### Patch Changes

- @nifrajs/coding-agent@5.4.0
  - @nifrajs/agent-app@5.4.0
  - @nifrajs/agent-protocol@5.4.0

## 5.3.0

### Patch Changes

- Updated dependencies [c8d7745]
- Updated dependencies [b186218]
- Updated dependencies [7093af2]
- Updated dependencies [d6b349c]
  - @nifrajs/agent-app@5.3.0
  - @nifrajs/agent-protocol@5.3.0
  - @nifrajs/coding-agent@5.3.0

## 5.2.1

### Patch Changes

- @nifrajs/agent-app@5.2.1
  - @nifrajs/agent-protocol@5.2.1
  - @nifrajs/coding-agent@5.2.1

## 5.2.0

### Patch Changes

- Updated dependencies [9498cf8]
  - @nifrajs/agent-app@5.2.0
  - @nifrajs/agent-protocol@5.2.0
  - @nifrajs/coding-agent@5.2.0

## 5.1.0

### Patch Changes

- Updated dependencies [abb4354]
  - @nifrajs/agent-app@5.1.0
  - @nifrajs/agent-protocol@5.1.0
  - @nifrajs/coding-agent@5.1.0

## 5.0.0

### Patch Changes

- c8577dd: The coding-agent RPC `approval.list` names each pending approval `approvalId`, the name `approval.resolve` takes, and keeps `id`. `AgentAppClient.listApprovals()` reads either name, so pending approvals from the RPC host are no longer dropped. The workbench refreshes its approval list when a turn reports `approval.required` or `approval.resolved`, while the turn is still streaming.
- Updated dependencies [7391acd]
- Updated dependencies [4417bc9]
- Updated dependencies [36bdc71]
- Updated dependencies [6b0db44]
- Updated dependencies [a3b3c51]
- Updated dependencies [343bae0]
- Updated dependencies [b435f13]
- Updated dependencies [c8577dd]
- Updated dependencies [1af7543]
- Updated dependencies [7775c2b]
- Updated dependencies [f41c20c]
- Updated dependencies [794c5f2]
- Updated dependencies [64e7416]
- Updated dependencies [a08e400]
- Updated dependencies [a1cfb14]
- Updated dependencies [bf3e16e]
- Updated dependencies [7403d72]
- Updated dependencies [4beafe6]
- Updated dependencies [d608a8d]
- Updated dependencies [f315597]
- Updated dependencies [854315c]
- Updated dependencies [2edff3a]
- Updated dependencies [191a235]
- Updated dependencies [f0474f3]
- Updated dependencies [d06daf1]
- Updated dependencies [4f8dc55]
- Updated dependencies [0e1b263]
- Updated dependencies [d5ea565]
- Updated dependencies [8ea8d46]
- Updated dependencies [6b0db44]
  - @nifrajs/agent-app@5.0.0
  - @nifrajs/agent-protocol@5.0.0
  - @nifrajs/coding-agent@5.0.0

## 4.0.2

### Patch Changes

- @nifrajs/agent-app@4.0.2
- @nifrajs/agent-protocol@4.0.2
- @nifrajs/coding-agent@4.0.2

## 4.0.1

### Patch Changes

- @nifrajs/agent-app@4.0.1
- @nifrajs/agent-protocol@4.0.1
- @nifrajs/coding-agent@4.0.1

## 4.0.0

### Patch Changes

- Updated dependencies [930ed0d]
- Updated dependencies [db9d1e1]
- Updated dependencies [d36c997]
- Updated dependencies [62fd960]
- Updated dependencies [2cbcca8]
- Updated dependencies [c7dcc3e]
- Updated dependencies [23cd462]
- Updated dependencies [3235050]
- Updated dependencies [07ce32c]
- Updated dependencies [e6cc620]
- Updated dependencies [1c9efd8]
- Updated dependencies [915e9d7]
- Updated dependencies [438d19b]
- Updated dependencies [e129e80]
- Updated dependencies [ae0f696]
- Updated dependencies [ef28ef9]
- Updated dependencies [3090e51]
  - @nifrajs/agent-app@4.0.0
  - @nifrajs/coding-agent@4.0.0
  - @nifrajs/agent-protocol@4.0.0

## 3.5.0

### Patch Changes

- Updated dependencies [6430334]
- Updated dependencies [322786e]
  - @nifrajs/agent-app@3.5.0
  - @nifrajs/coding-agent@3.5.0
  - @nifrajs/agent-protocol@3.5.0

## 3.4.0

### Patch Changes

- Updated dependencies [8d23613]
- Updated dependencies [719d82e]
  - @nifrajs/agent-app@3.4.0
  - @nifrajs/agent-protocol@3.4.0
  - @nifrajs/coding-agent@3.4.0

## 3.3.0

### Patch Changes

- Updated dependencies [10085ce]
  - @nifrajs/coding-agent@3.3.0
  - @nifrajs/agent-app@3.3.0
  - @nifrajs/agent-protocol@3.3.0

## 3.2.0

### Patch Changes

- Updated dependencies [1a041a9]
- Updated dependencies [e3e197b]
  - @nifrajs/agent-app@3.2.0
  - @nifrajs/coding-agent@3.2.0
  - @nifrajs/agent-protocol@3.2.0
